"""A Codie BLE wire-protokoll — **routing nélküli** generáció.

Ez a robotunk (a stabil ``00:07:80:66:F0:DA`` cím) beszél. A frame nincs
routing/INFO bájtja:

    SEQ(2 LE) | CMD(2 LE) | PARAM...

a parancsok és az érzékelő-kérdések pedig külön karakterisztikán mennek
(action illetve request), mindkettőnek van egy indicate-párja.

A formátum forrása a [zbettenbuk/codiejs](https://github.com/zbettenbuk/codiejs)
leírása; a JS port (``server/src/ble/protocol-norrouting.js``) bájtra bájtra
ezt követi, és a ``server/test/parity.test.js`` ellenőrzi.

Különbségek a routingos generációhoz képest:

* nincs routing/INFO bájt és nincs ARGLEN — a CMD u16;
* két író és két válasz-karakterisztika;
* a LED színe más skálán megy (hue 0..360 → ×0,7; sat/val 0..100 → ×2,55);
* a szenzor-válasz formája ``SEQ(2) | VALUE(változó hosszúságú, LE)``;
* a vonalérzékelő **egyetlen** 32 bites fix-pontos számot ad, nem két
  12 bites értéket.
"""

from __future__ import annotations

import math

from .wire import color_hsv

__all__ = [
    "SERVICE_UUID",
    "REQUEST_UUID",
    "REQUEST_REPLY_UUID",
    "ACTION_UUID",
    "ACTION_REPLY_UUID",
    "CMD_ECHO",
    "CMD_MOVE",
    "CMD_MOTOR_BOTH",
    "CMD_MOTOR_LEFT",
    "CMD_MOTOR_RIGHT",
    "CMD_TURN",
    "CMD_BEEP",
    "CMD_SET_COLOR",
    "CMD_SET_ANIMATION",
    "QUERY_DISTANCE",
    "QUERY_BATTERY",
    "QUERY_SOUND",
    "QUERY_LIGHT",
    "QUERY_LINE",
    "MAX_BEEP_MS",
    "LINE_SCALE",
    "LINE_THRESHOLD",
    "u16",
    "u8",
    "i8",
    "build_frame",
    "decode_reply",
    "normalize_distance",
    "normalize_battery",
    "decode_line",
    "color_params",
]

# --- BLE GATT azonosítók (a codiejs konfigurációja alapján) --------------

SERVICE_UUID = "d46e7e53-ba2f-4044-ade9-f85ead45f458"
#: Ide írunk az érzékelő-kérést; a válasz itt jön (indicate).
REQUEST_UUID = "25ad752e-7a42-4c90-8526-90e85fb3741d"
REQUEST_REPLY_UUID = "02a92ec6-0e7e-415c-a311-828a802c61d5"
#: Ide írunk a parancsot (beep, LED, motor); a válasz itt jön (indicate).
ACTION_UUID = "0b08f48d-a33f-4a93-ad25-84928e2ef792"
ACTION_REPLY_UUID = "8a7f8f01-8679-400c-b32b-464c71f5d06b"

# --- Parancs-ID-k ---------------------------------------------------------

CMD_ECHO = 0x00
CMD_MOVE = 0x01  # distance u16 (mm), leftSpeed i8, rightSpeed i8
CMD_MOTOR_BOTH = 0x02  # leftSpeed i8, rightSpeed i8
CMD_MOTOR_LEFT = 0x03  # speed i8
CMD_MOTOR_RIGHT = 0x04  # speed i8
CMD_TURN = 0x05  # angle u16 (°), speed i8
CMD_BEEP = 0x06  # volume u8, frequency u16 (Hz), duration u16 (ms)
CMD_SET_COLOR = 0x08  # hue u8, saturation u8, value u8
CMD_SET_ANIMATION = 0x09  # animation u8, hue u8, sat u8, repeat u8, speed u8

# A motorsebesség **előjeles** (i8, két's komplemens): a codiejs referencia is
# így küldi, és a `turn` dokumentáltan "pozitív speed = balra" — vagyis a
# firmware a bájtot i8-ként értelmezi. A 0..100 a pozitív sebesség
# tartománya; a negatív a visszafelé.

# --- Érzékelő-kérdések (a request karakterisztikára) ----------------------

QUERY_DISTANCE = 0x01  # -> mm
QUERY_BATTERY = 0x02  # -> %
QUERY_SOUND = 0x03  # -> raw (0..~2048)
QUERY_LIGHT = 0x04  # -> raw (0..4096)
QUERY_LINE = 0x05  # -> raw

MAX_BEEP_MS = 10000

#: A vonalérzékelő 2^20-as skálája (a codiejs referencia).
LINE_SCALE = 1024 * 1024
#: A "vonalt követ" küszöb a skálán (a codiejs `lineThreshold`).
LINE_THRESHOLD = 30


# --- Bájt-segédek --------------------------------------------------------


def u16(value: int) -> bytes:
    """u16 little-endian bájtok."""
    v = value & 0xFFFF
    return bytes([v & 0xFF, (v >> 8) & 0xFF])


def u8(value: int) -> bytes:
    """u8 bájt."""
    return bytes([value & 0xFF])


def i8(value: int) -> bytes:
    """i8 két's komplemens bájt."""
    return bytes([value & 0xFF])


# --- Frame kódolás --------------------------------------------------------


def build_frame(cmd: int, params: bytes = b"", seq: int = 0) -> bytes:
    """Parancs-frame: ``SEQ(2 LE) | CMD(2 LE) | PARAM...``."""
    return u16(seq) + u16(cmd) + bytes(params)


def decode_reply(data: bytes) -> dict | None:
    """A válasz-frame dekódolása.

    A valós robot válasza: ``SEQ(2 LE) | VALUE(változó hosszúságú, LE)``.
    Élőben mért hosszak: akku 1 bájt, távolság/fény/hang 2 bájt, vonal 4 bájt,
    parancs-nyugta 1 bájt (0x00). A VALUE ezért a maradék bájtok little-endian
    száma — nem fix szélességű.

    Returns:
        ``{"seq", "value", "payload"}`` vagy ``None``, ha a frame túl rövid.
    """
    if len(data) < 3:
        return None
    seq = data[0] | (data[1] << 8)
    payload = data[2:]
    value = 0
    for byte in reversed(payload):
        value = value * 256 + byte
    return {"seq": seq, "value": value, "payload": payload}


# --- Érzékelő-értékek normalizálása (a codiejs alapján) -----------------


def _round_half_up(value: float) -> int:
    """A JS ``Math.round`` szemantikája (félre felfelé, nem banker's rounding).

    A Python ``round()`` párosra kerekít, a JS félre mindig felfelé — a
    kerekítési eltérést a paritás-teszt ezért így érzékeli.
    """
    return math.floor(value + 0.5)


def normalize_distance(raw: int) -> int:
    """Távolság: a nyers érték 0,1 mm egységben érkezik."""
    return _round_half_up(raw / 10)


def normalize_battery(raw: int) -> int:
    """Akku: százalék, 100-ra vágva."""
    return min(raw, 100)


def decode_line(payload: bytes) -> dict:
    """A vonal-érzékelő 4 bájtos értékének dekódolása.

    Ebben a generációban a vonalérzékelő **nem** két 12 bites értéket ad
    (mint a routingos generáció ``LineGetRaw`` parancsa), hanem egyetlen
    32 bites, fix-pontos számot. Élőben mérve (2026-10-20, 60 minta): a
    bájtminta mindig ``0x05xx07yy`` volt — ez egyetlen fix-pontos érték.

    Returns:
        ``{"value", "level", "onLine"}``.
    """
    value = int.from_bytes(bytes(payload[:4]), "little") if len(payload) >= 4 else 0
    level = _round_half_up(value / LINE_SCALE * 100) / 100
    return {"value": value, "level": level, "onLine": level > LINE_THRESHOLD}


def color_params(color: str) -> tuple[int, int, int]:
    """A LED színének paraméterei ebben a generációban.

    A firmware más skálát használ, mint a routingos generáció: a hue-t
    0..360-ból ×0,7-szeresen, a saturation/value-ot 0..100-ból ×2,55-szeresen
    küldi (a 0..255-ös HSV-ból számolva).
    """
    h, s, v = color_hsv(color)
    return (
        math.floor((h / 255) * 360 * 0.7) & 0xFF,
        _round_half_up((s / 255) * 100 * 2.55) & 0xFF,
        _round_half_up((v / 255) * 100 * 2.55) & 0xFF,
    )
