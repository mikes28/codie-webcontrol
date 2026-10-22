"""A robot firmware-jének parancsnyelve — a visszafejtett 0.5.0hw2.1 alapján.

A firmware nem bináris frame-eket beszél a telefon felé: a BLE modult AT
parancsokkal (BLE-boot, PPRT/PPRET) indítja, és egy **szöveges** konzol-
protokollon válaszol:

    kérés     : ``<get|set|call> <interface> <op> [args...]``
    válasz    : ``<get|set|call> <interface> <op> [value]``
    üzenet    : ``call :proxy message <level> <text>[extra]``
    köszöntő  : ``call :proxy greeting "k":"v" ... "msg:<text>"``

Ez a modul a C referencia (``fw/modules/proxy.c``) byte-exakt portja: ugyanaz
a szó-tábla, ugyanaz a ``strtok``-os tokenizálás (a szóközökből hasítva, a
vezető szóközök kihagyva), ugyanaz a három válaszforma.

A visszafejtésből **szemantika** is jött: melyik interfész milyen op-ot
fogad, milyen egységben válaszol, és melyik hibát adja vissza. Ez a
``INTERFACES`` táblázat — a projektben eddig csak a parancs-ID-k voltak
ismertek, a valódi viselkedés nem.

Két quirk, amit a firmware kényszerít a hívóra:

* **A számok hexadecimálisak.** A firmware minden érzékelőértéket 16-os
  számrendszerben ír ki (``fmt_num(value, 16, …)``); az egyetlen kivétel a
  ``hwiAdc buf`` ADC-kimutatás, ami 10-es alapon megy. A ``radix`` mező ezt
  tartalmazza, a ``parse_number`` pedig a megfelelő alapon értelmezi.
* **A válasz szava nem mindig a kérés szava.** A ``drvBattery`` és a
  ``hwiDrive`` válaszai a C forrásban ``OP_SET``-tel vannak beégetve, tehát
  egy ``get drvBattery voltage`` kérésre ``set drvBattery voltage 7b0`` jön
  vissza. A ``reply_word`` mező ezt tartalmazza.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

__all__ = [
    "OP_GET",
    "OP_SET",
    "OP_CALL",
    "OP_WORDS",
    "LOG_LEVELS",
    "VERBS",
    "GREETING",
    "ProtocolError",
    "Command",
    "Reply",
    "Op",
    "Interface",
    "INTERFACES",
    "build_request",
    "parse_request",
    "parse_reply",
    "parse_number",
    "format_number",
    "interface",
    "op",
    "describe",
]


# --- a firmware protokollállandói ---------------------------------------

OP_GET = 1
OP_SET = 2
OP_CALL = 3

#: a firmware szó-táblája (C: op_word_tbl, flash 0x0800B820)
OP_WORDS: tuple[str, ...] = ("???", "get", "set", "call")

#: a naplózási szintek (C: log_word_tbl, flash 0x0800B834)
LOG_LEVELS: tuple[str, ...] = ("???", "inf", "dbg", "wrn", "err")

#: a kérésben használható igék
VERBS: tuple[str, ...] = ("get", "set", "call")

#: a boot köszöntője (C: main.c, a RAM 0x20000A14 tömbje)
GREETING: dict[str, str] = {
    "ver": "0.5.0hw2.1",
    "mat": "4",
    "date": "1602121419",
    "ttpms": "1000",
    "+ack": "0",
}

#: a firmware hibaválasza egy értelmezhetetlen kérésre
ERROR_INVALID_COMMAND = "Invalid command!"

#: ismeretlen interfész esetén a firmware ezt az előtagot küldi, majd a nevet
ERROR_NO_INTERFACE = "No interface:"

#: a parancs-puffer túlcsordulása (a firmware 40 byte-os sort vár)
ERROR_CMD_BUF_OVERFLOW = "possible cmdBuf overflow"

#: a BLE gyűrű túlcsordulása
ERROR_BUF_OVERFLOW = "BUFOVF!!!!!"

#: a BLE modul kapcsolati hibái (a USART hibajelzői)
BLE_ERRORS: tuple[str, ...] = (
    "BLE framing error",
    "BLE USART noise",
    "BLE USART overrun",
    "USART framing error",
    "USART noise",
    "USART overrun",
    "ERR:BLE_serout_TO",
)

#: a firmware parancs-puffere (a teljes sor, a terminátor nélkül)
CMD_BUF_SIZE = 40

#: a BLE modul AT-protokolljának sorai (a modul USART-on beszél a firmwaremel)
BLE_LINK_LINES: tuple[str, ...] = ("BLE-boot", "PPRT", "PPRET", "+ack")


class ProtocolError(ValueError):
    """A firmware protokollhibája (értelmezhetetlen kérés vagy válasz)."""


# --- számformázás (a firmware uitoa/itoa portja) -------------------------


def format_number(value: int, radix: int = 16) -> str:
    """Egy számot a firmware módjára ír ki.

    A firmware ``uitoa``-ja 10..35-öt a ``'W' + digit`` eltolással alakítja
    betűvé, ami ``'a'``..``'f'``-et ad — ugyanazt a kisbetűs alakot, amit a
    firmware kiír.

    Args:
        value: az érték (negatív előjel nélkül, az előjel külön).
        radix: 10 (decimális) vagy 16 (hexa, ahogy a firmware az érzékelőket írja).

    Returns:
        A szám szöveges alakja.
    """
    if radix < 2 or radix > 36:
        radix = 10
    if value < 0:
        return "-" + format_number(-value, radix)
    if value == 0:
        return "0"
    digits: list[str] = []
    while value:
        digit = value % radix
        value //= radix
        digits.append(chr(ord("0") + digit) if digit < 10 else chr(ord("W") + digit))
    return "".join(reversed(digits))


def parse_number(text: str, radix: int = 16) -> int:
    """A firmware által kiírt számértéket értelmezi.

    Args:
        text: a válaszban szereplő szám (a firmware 16-on írja ki).
        radix: a számrendszer, amiben a firmware kiírta.

    Returns:
        Az érték.

    Raises:
        ProtocolError: ha a szöveg nem szám.
    """
    text = text.strip()
    if not text:
        raise ProtocolError("Üres számérték a válaszban.")
    try:
        return int(text, radix)
    except ValueError as exc:
        raise ProtocolError(f"Nem értelmezhető szám: {text!r} (radix {radix}).") from exc


# --- kérések --------------------------------------------------------------


@dataclass(frozen=True)
class Command:
    """Egy firmware-kérés: ``<verb> <interface> <op> [args...]``."""

    verb: str
    interface: str
    op: str
    args: tuple[str, ...] = ()

    def line(self) -> str:
        """A kérés szöveges alakja (a sort a firmware maga terminálja)."""
        parts = [self.verb, self.interface, self.op, *self.args]
        return " ".join(part for part in parts if part != "")

    @classmethod
    def parse(cls, line: str) -> "Command":
        """A kérés visszafejtése a firmware ``strtok``-os tokenizálása szerint.

        Raises:
            ProtocolError: ha az ige vagy az interfész hiányzik (a firmware
                ekkor ``Invalid command!`` hibát küld).
        """
        tokens = line.split()
        if len(tokens) < 3 or tokens[0] not in VERBS:
            raise ProtocolError(ERROR_INVALID_COMMAND)
        return cls(tokens[0], tokens[1], tokens[2], tuple(tokens[3:]))


def build_request(verb: str, interface_name: str, op_name: str, *args: str) -> str:
    """Kérés szöveges alakja (a nyitó ``{verb} {interface} {op} {args…}``).

    Raises:
        ProtocolError: ha az ige nem egyezik a firmware három igejével.
    """
    if verb not in VERBS:
        raise ProtocolError(f"Ismeretlen ige: {verb!r} (a firmware csak {VERBS}-t fogad).")
    return " ".join(part for part in (verb, interface_name, op_name, *args) if part != "")


def parse_request(line: str) -> Command:
    """Lásd :meth:`Command.parse`."""
    return Command.parse(line)


# --- válaszok -------------------------------------------------------------


@dataclass(frozen=True)
class Reply:
    """A firmware válasza.

    A három forma egy közös típusba kerül, hogy a hívó ne csak a sort
    lássa, hanem a tartalmát is:

    * ``kind="value"`` — ``<word> <interface> <op> [value]``
    * ``kind="message"`` — ``call :proxy message <level> <text>[extra]``
    * ``kind="greeting"`` — ``call :proxy greeting "k":"v" … "msg:<text>"``
    """

    kind: str
    verb: str = ""
    interface: str = ""
    op: str = ""
    value: str | None = None
    level: str = ""
    text: str = ""
    fields: dict[str, str] = field(default_factory=dict)

    @property
    def is_error(self) -> bool:
        """True, ha ez a firmware hibaüzenete (``err`` szintű ``:proxy`` üzenet)."""
        return self.kind == "message" and self.level == "err"

    def number(self, radix: int = 16) -> int | None:
        """A válaszérték számként.

        Args:
            radix: a számrendszer — a firmware az érzékelőket 16-on írja ki,
                a ``hwiAdc buf`` és a ``hwiMic level`` viszont 10-en.

        Returns:
            Az érték, vagy ``None`` ha nincs érték a válaszban.
        """
        if self.value is None:
            return None
        return parse_number(self.value, radix)


def _parse_greeting_fields(text: str) -> tuple[dict[str, str], str]:
    """A köszöntő mezőinek kiolvasása.

    A firmware a mezőket ``"key"":"value"`` alakban írja ki (a kulcs és az
    érték is külön idézőjelben), a szöveget pedig egyetlen ``"msg:<text>"``
    tokenben.

    Returns:
        ``(mezők, üzenet)``.
    """
    fields: dict[str, str] = {}
    message = ""
    index = 0
    length = len(text)
    while index < length:
        if text[index] != '"':
            index += 1
            continue
        end = text.find('"', index + 1)
        if end < 0:
            break
        token = text[index + 1 : end]
        index = end + 1
        probe = index
        while probe < length and text[probe] == " ":
            probe += 1
        if probe < length and text[probe] == ":":
            value_start = probe + 1
            while value_start < length and text[value_start] == " ":
                value_start += 1
            if value_start < length and text[value_start] == '"':
                value_end = text.find('"', value_start + 1)
                if value_end >= 0:
                    fields[token] = text[value_start + 1 : value_end]
                    index = value_end + 1
                    continue
        if token.startswith("msg:"):
            message = token[4:]
    return fields, message


def parse_reply(line: str) -> Reply:
    """A firmware válaszának visszafejtése.

    Raises:
        ProtocolError: ha a sor nem három ismert forma egyike.
    """
    text = line.strip()
    if not text:
        raise ProtocolError("Üres válaszsor.")

    parts = text.split()
    verb = parts[0]
    if verb not in VERBS:
        raise ProtocolError(f"Ismeretlen válaszszó: {verb!r} — {text!r}")

    # call :proxy message <level> <text>[extra]
    if len(parts) >= 4 and parts[1] == ":proxy" and parts[2] == "message":
        level = parts[3]
        body = text.split(None, 4)
        message = body[4] if len(body) > 4 else ""
        return Reply(kind="message", verb=verb, level=level, text=message)

    # call :proxy greeting "k":"v" ... "msg:<text>"
    if len(parts) >= 3 and parts[1] == ":proxy" and parts[2] == "greeting":
        body = text.split(None, 3)
        payload = body[3] if len(body) > 3 else ""
        fields, message = _parse_greeting_fields(payload)
        return Reply(kind="greeting", verb=verb, fields=fields, text=message)

    # <word> <interface> <op> [value]
    if len(parts) >= 3:
        value = parts[3] if len(parts) > 3 else None
        return Reply(kind="value", verb=verb, interface=parts[1], op=parts[2], value=value)

    raise ProtocolError(f"Nem értelmezhető válasz: {text!r}")


# --- a firmware interfész-regisztere (a szemantika) ----------------------


@dataclass(frozen=True)
class Op:
    """Egy firmware-op: mit csinál, milyen argumentumot kap, mit válaszol."""

    name: str
    verbs: tuple[str, ...]
    args: str = ""
    unit: str = ""
    radix: int = 10
    reply_word: str = ""
    replies: bool = True
    wildcard: bool = False
    note: str = ""


@dataclass(frozen=True)
class Interface:
    """Egy firmware-interfész a hozzá tartozó opokkal."""

    name: str
    ops: tuple[Op, ...]
    note: str = ""


def _op(
    name: str,
    verbs: tuple[str, ...],
    args: str = "",
    unit: str = "",
    radix: int = 10,
    reply_word: str = "",
    replies: bool = True,
    wildcard: bool = False,
    note: str = "",
) -> Op:
    return Op(name, verbs, args, unit, radix, reply_word, replies, wildcard, note)


#: A firmware 16 interfésze a saját táblázatuk sorrendjében (C: proxy.c).
INTERFACES: tuple[Interface, ...] = (
    Interface(
        "hwiAdc",
        (
            _op("buf", ("get",), "—", "ADC", 10, note="32 érték, soronként, 8 érték után üres sor"),
        ),
        "nyers ADC-csatornák",
    ),
    Interface(
        "hwiLed",
        (
            _op("on", ("get",), "<led 0-3>", "duty 0-255", 10),
            _op("on", ("set",), "<led 0-3> <on|1|true>", "0/1", 10),
            _op("pwm", ("get",), "<led 0-3>", "duty 0-255", 10),
            _op("pwm", ("set",), "<led 0-3> <duty 0-255>", "duty 0-255", 10),
            _op("*", ("get",), "—", "kikapcsolt LED-ek száma", 10, wildcard=True),
        ),
        "a board 4 státusz-LED-je",
    ),
    Interface(
        "hwiDrive",
        (
            _op("dutyA", ("set",), "<hex>", "tick (-1000..1000)", 16, replies=False, note="a hex argumentum a motor A PWM-je"),
            _op("dutyB", ("set",), "<hex>", "tick (-1000..1000)", 16, replies=False, note="a hex argumentum a motor B PWM-je"),
            _op("nFault", ("get",), "—", "0", 10, reply_word="set", note="a hibabemenetet olvassa, az eredményt eldobja"),
        ),
        "a két motor meghajtója",
    ),
    Interface(
        "drvBattery",
        (
            _op("voltage", ("get",), "—", "mV", 16, reply_word="set"),
            _op("temp", ("get",), "—", "0.1 °C", 16, reply_word="set"),
            _op("current", ("get",), "—", "mA", 16, reply_word="set"),
            _op("remainingCapacity", ("get",), "—", "%", 16, reply_word="set"),
            _op("chargeStat", ("get",), "—", "állapot 0-2", 16, reply_word="set"),
            _op("hwInit", ("call",), "—", "", 10, replies=False, note="a inicializálás nem válaszol"),
        ),
        "az akkumulátor csomag",
    ),
    Interface(
        "hwiSonar",
        (),
        "a firmwareben nincs opja — a szonár a periodikus feladatban fut",
    ),
    Interface(
        "bleCom",
        (
            _op("buf", ("get",), "—", "byte", 10, note="a RX gyűrűben váró bájtok száma"),
            _op("write", ("set",), "<szöveg>", "byte", 10),
            _op("echo", ("call",), "<szöveg>", "byte", 10),
            _op("*", ("get",), "—", "byte", 10, wildcard=True),
        ),
        "a BLE modul összeköttetése",
    ),
    Interface(
        "hwiBuzz",
        (
            _op("play", ("get", "set", "call"), "<pattern 0-4>", "", 10, note="a hangminta sorszáma"),
            _op("stop", ("get", "set", "call"), "—", "", 10),
            _op("*", ("get",), "—", "", 10, wildcard=True),
        ),
        "a csipogó (a hangmagasság fix, a ritmus váltogatja)",
    ),
    Interface(
        "hwiMic",
        (
            _op("level", ("get",), "—", "0..2048", 10),
            _op("*", ("get",), "—", "0..2048", 10, wildcard=True),
        ),
        "a mikrofon erősségi szintje",
    ),
    Interface(
        "hwiEnc",
        (),
        "a firmwareben nincs opja — a kerekek encodere a periodikus feladatban fut",
    ),
    Interface(
        "hwiLine",
        (
            _op("read", ("get",), "<sensor 0-1>", "nyers ADC", 10),
            _op("mask", ("get",), "—", "bitmask", 10),
            _op("*", ("get",), "—", "bitmask", 10, wildcard=True),
        ),
        "a vonalérzékelő sor",
    ),
    Interface(
        "hwiPower",
        (
            _op("pwrOff", ("call",), "—", "", 10, replies=False, note="a robotot kikapcsolja — nem válaszol"),
            _op("Vsens", ("set",), "<on|1|true|off>", "0/1", 10),
            _op("*", ("get",), "—", "0/1", 10, wildcard=True, note="a tápellátás 'good' vonala"),
        ),
        "a tápellátás és a kapcsoló",
    ),
    Interface(
        "hwiLightSense",
        (
            _op("read", ("get",), "<sensor>", "0-255", 10),
            _op("level", ("get",), "—", "0-255", 10),
            _op("*", ("get",), "—", "0-255", 10, wildcard=True),
        ),
        "a környezeti fény érzékelői",
    ),
    Interface(
        "appLights",
        (),
        "a firmwareben nincs opja — a 12 címezhető LED a periodikus feladatban fut",
    ),
    Interface(
        "appDrive",
        (),
        "a firmwareben nincs opja — a mozgás a periodikus feladatban fut",
    ),
    Interface(
        "appSys",
        (
            _op("ver", ("get",), "—", "", 10),
            _op("mat", ("get",), "—", "", 10),
            _op("date", ("get",), "—", "", 10),
            _op("ttpms", ("get",), "—", "ms", 10),
            _op("hwInit", ("call",), "—", "", 10, replies=False, note="a teljes inicializálás nem válaszol"),
        ),
        "a rendszerinformáció",
    ),
    Interface(
        "appLightSense",
        (),
        "a firmwareben nincs opja — a fényérzékelés a periodikus feladatban fut",
    ),
)


def interface(name: str) -> Interface | None:
    """Az interfész a regiszterben (``None``, ha nincs ilyen)."""
    for item in INTERFACES:
        if item.name == name:
            return item
    return None


def op(interface_name: str, op_name: str, verb: str | None = None) -> Op | None:
    """Egy op a regiszterben (``None``, ha nincs ilyen).

    Args:
        interface_name: az interfész neve.
        op_name: az op neve.
        verb: az ige (``get``/``set``/``call``) — ha meg van adva, csak a
            hozzá illő opot adja vissza, és a ``*`` (bármely más op) csak
            akkor jön szóba, ha nincs pontos egyezés.
    """
    found = interface(interface_name)
    if found is None:
        return None
    wildcard: Op | None = None
    for item in found.ops:
        if item.wildcard:
            if wildcard is None and (verb is None or verb in item.verbs):
                wildcard = item
            continue
        if item.name == op_name and (verb is None or verb in item.verbs):
            return item
    return wildcard


def describe(interfaces: Iterable[str] | None = None) -> list[str]:
    """Emberi olvasásra szólt interfész-lista (a help és a dokumentáció szerint)."""
    wanted = set(interfaces) if interfaces else None
    lines: list[str] = []
    for item in INTERFACES:
        if wanted is not None and item.name not in wanted:
            continue
        lines.append(f"{item.name} — {item.note}")
        for entry in item.ops:
            name = "<bármely op>" if entry.wildcard else entry.name
            unit = f" [{entry.unit}]" if entry.unit else ""
            answer = "nem válaszol" if not entry.replies else (
                "válasz" if not entry.reply_word else f"'{entry.reply_word}' válasz"
            )
            lines.append(
                f"    {'/'.join(entry.verbs)} {item.name} {name} {entry.args}".rstrip()
                + unit
                + f" — {answer}"
            )
    return lines
