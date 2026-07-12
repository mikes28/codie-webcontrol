"""Codie BLE wire-protokoll — frame kódolás/dekódolás.

Visszafejtve a csorbazoli/CodieController repo `DataPackage.java`,
`CodieCommandType.java` és a parancs-/szenzorosztályok alapján.

Frame (little-endian, max 20 byte):

    INFO(1) | SEQ(2) | CMD(2) | ARGLEN(2) | ARGDAT...

A modul szándékosan függőségmentes és mellékhatás-nélküli (a szekvencia-számláló
kivételével), hogy unit-tesztelhető legyen a robot nélkül.
"""

from __future__ import annotations

import colorsys

# --- BLE GATT azonosítók -------------------------------------------------

SERVICE_UUID = "52af0001-978a-628d-c845-0a104ca2b8dd"
WRITE_UUID = "52af0002-978a-628d-c845-0a104ca2b8dd"   # write / write-without-response
NOTIFY_UUID = "52af0003-978a-628d-c845-0a104ca2b8dd"  # notify (válasz / szenzoradat)

# --- Szerepek (ordinal) és prioritás -------------------------------------

ROLE_APP = 0
ROLE_MCU = 1
ROLE_BLE = 2
ROLE_BROADCAST = 3

PRIO_NORMAL = 0x00
PRIO_HIGH = 0x08

# --- Parancs-ID-k (CodieCommandType) -------------------------------------

CMD_DRIVE_SPEED = 0x1060      # leftSpeed i8, rightSpeed i8  (%)
CMD_DRIVE_DISTANCE = 0x1061   # distance u16 (mm), leftSpeed i8, rightSpeed i8
CMD_DRIVE_TURN = 0x1062       # degree u16 (°), speed i8  (+ balra, - jobbra)
CMD_SONAR = 0x1063            # (szenzor) -> range u16 (mm)
CMD_SPEAK_BEEP = 0x1064       # duration u16 (ms, max 10000)
CMD_LED_SET_COLOR = 0x1065    # ledMask u16, hue u8, sat u8, val u8  (HSV 0-255!)
CMD_LED_START_ANIM = 0x1066   # beépített animáció
CMD_APP_CONNECTED = 0x1067    # app csatlakozás jelzése az MCU-nak
CMD_APP_DISCONNECTED = 0x1068  # app leválás jelzése
CMD_BATTERY = 0x1069          # (szenzor) -> soc u8 (%)
CMD_LIGHT = 0x106A            # (szenzor) -> u16 (12 bit, 0=legvilágosabb..4095=legsötétebb)
CMD_LINE = 0x106B             # (szenzor) -> left u16, right u16 (12 bit)
CMD_MIC = 0x106C              # (szenzor) -> u16 (0..~2048)
CMD_SWITCH_BOOTLOADER = 0x106D  # VESZÉLYES — bootloaderbe vált, ne használd
CMD_BATTERY_VOLTAGE = 0x106E  # (szenzor) -> u16; MEGJEGYZÉS: ezen a firmware-en nincs válasz

# A válaszcsomagban innen kezdődnek az argumentumok:
# INFO(1)+SEQ(2)+CMD(2)+ARGLEN(2)+REQSEQ(2) = 9
RESPONSE_ARG_POS = 9

MAX_BEEP_MS = 10000

# --- Színek --------------------------------------------------------------
# A hivatalos Codie BLE API (v1.0) szerint a hue/sat/val 0-255 tartományban megy.
# (A Java CodieController tévesen 0-100-zal skálázott — az itt javítva van.)

COLORS_RGB = {
    "white": (255, 255, 255),
    "green": (0, 255, 0),
    "red": (255, 0, 0),
    "blue": (0, 0, 255),
    "cyan": (0, 255, 255),
    "yellow": (255, 255, 0),
    "orange": (255, 200, 0),
}


def color_hsv(name: str) -> tuple[int, int, int]:
    """Egy szín HSV értéke 0..255 skálán (hivatalos Codie BLE API v1.0)."""
    try:
        r, g, b = COLORS_RGB[name]
    except KeyError as exc:
        raise ValueError(f"Ismeretlen szín: {name!r}. Választható: {', '.join(COLORS_RGB)}") from exc
    h, s, v = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
    return int(h * 255), int(s * 255), int(v * 255)


# --- Alacsonyszintű bájt-segédek -----------------------------------------

def _u16(value: int) -> bytes:
    return bytes([value & 0xFF, (value >> 8) & 0xFF])


def _u8(value: int) -> bytes:
    return bytes([value & 0xFF])


def _i8(value: int) -> bytes:
    return bytes([value & 0xFF])  # two's complement a 0xFF maszkkal


def info_byte(sender: int = ROLE_APP, dest: int = ROLE_MCU, prio: int = PRIO_NORMAL) -> int:
    """INFO bájt: (sender<<4) | (dest<<6) | prio."""
    return ((sender << 4) | (dest << 6) | prio) & 0xFF


# --- Szekvencia-számláló -------------------------------------------------

_seq = 0


def next_seq() -> int:
    global _seq
    _seq = 1 if _seq >= 0xFFFF else _seq + 1
    return _seq


def reset_seq() -> None:
    global _seq
    _seq = 0


# --- Frame összeállítás --------------------------------------------------

def build_frame(
    cmd_id: int,
    args: bytes = b"",
    seq: int | None = None,
    sender: int = ROLE_APP,
    dest: int = ROLE_MCU,
    prio: int = PRIO_NORMAL,
) -> tuple[bytes, int]:
    """Összeállít egy kérés-frame-et. Visszaadja (frame, seq)."""
    if seq is None:
        seq = next_seq()
    arglen = len(args)
    header = bytes(
        [
            info_byte(sender, dest, prio),
            seq & 0xFF,
            (seq >> 8) & 0xFF,
            cmd_id & 0xFF,
            (cmd_id >> 8) & 0xFF,
            arglen & 0xFF,
            (arglen >> 8) & 0xFF,
        ]
    )
    return header + bytes(args), seq


# --- Argumentum-építők parancsonként -------------------------------------

def beep_args(duration_ms: int) -> bytes:
    return _u16(max(0, min(duration_ms, MAX_BEEP_MS)))


def led_all_args(color: str) -> bytes:
    """Mind a 12 LED egy színre. ledMask = 0x0FFF (mind a 12 bit).

    Megjegyzés: az eredeti Java 0x08FF-et küldött (feltehető hiba); itt a
    korrekt 0x0FFF-et használjuk, hogy tényleg mind a 12 LED váltson.
    """
    h, s, v = color_hsv(color)
    return _u16(0x0FFF) + _u8(h) + _u8(s) + _u8(v)


def led_single_args(color: str, index: int) -> bytes:
    """Egyetlen LED (index 1..12) beállítása."""
    index = max(1, min(index, 12))
    mask = 1 << (index - 1)
    h, s, v = color_hsv(color)
    return _u16(mask) + _u8(h) + _u8(s) + _u8(v)


def drive_speed_args(left: int, right: int) -> bytes:
    return _i8(left) + _i8(right)


def drive_distance_args(distance_mm: int, left: int, right: int) -> bytes:
    return _u16(distance_mm) + _i8(left) + _i8(right)


def drive_turn_args(degree: int, speed: int) -> bytes:
    return _u16(degree) + _i8(speed)


# --- Válasz dekódolás ----------------------------------------------------

def decode_response(data: bytes) -> dict | None:
    """A notify-csatornán érkező válasz értelmezése.

    A válasz CMD felső bájtja 0x80-nal jelölt (MCU->APP). A REQSEQ mező a
    kérésünk SEQ-jét tükrözi, ezzel párosítható a válasz.
    """
    if len(data) < RESPONSE_ARG_POS:
        return None
    seq = data[1] | (data[2] << 8)
    cmd = (data[3] | (data[4] << 8)) & 0x7FFF  # MSB levágva
    arglen = data[5] | (data[6] << 8)
    req_seq = data[7] | (data[8] << 8)
    args = data[RESPONSE_ARG_POS:]
    return {"seq": seq, "cmd": cmd, "arglen": arglen, "req_seq": req_seq, "args": args}


def read_u16(args: bytes, offset: int) -> int | None:
    if len(args) < offset + 2:
        return None
    return args[offset] | (args[offset + 1] << 8)


def read_u8(args: bytes, offset: int) -> int | None:
    if len(args) < offset + 1:
        return None
    return args[offset]
