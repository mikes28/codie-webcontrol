"""A Codie robot magas szintű API-ja — bármilyen transzport fölött.

A réteg felelőssége egy helyen van: a **mit** érdemes kérni a robottól. A
*hogyan* jut el hozzá a transzport dolga (a REST API a Node.js backenden
keresztül, vagy közvetlen BLE).

A parancsszótár megegyezik a backend ``src/commands.js`` rétegével, így a
Python, a REST API, a CLI és a felület ugyanazt a viselkedést adja:

    beep  morse  tune  led  ledSingle  ledsOff  ledAnim
    forward  backward  turn  stop
    status  battery  sonar  light  line  mic

Minden mozgásparancs **véges** (magától megáll), a ``turn`` előjele pedig a
projekt konvenciója: pozitív fok = jobbra.
"""

from __future__ import annotations

from typing import Any, Protocol

__all__ = ["COMMAND_NAMES", "Transport", "Robot", "RobotError"]


#: A robot által támogatott parancsok (a backend parancsszótára).
COMMAND_NAMES: tuple[str, ...] = (
    "beep",
    "morse",
    "tune",
    "led",
    "ledSingle",
    "ledsOff",
    "ledAnim",
    "forward",
    "backward",
    "turn",
    "stop",
    "status",
    "battery",
    "sonar",
    "light",
    "line",
    "mic",
)

#: A leghosszabb megengedett egyirányú mozgás (cm).
MAX_DISTANCE_CM = 200


class RobotError(RuntimeError):
    """A robot nem hajtotta végre a kérést.

    Attributes:
        action: a parancs neve.
        cause: az eredeti hiba (``None``, ha nincs).
    """

    def __init__(self, action: str, message: str, cause: BaseException | None = None) -> None:
        self.action = action
        self.cause = cause
        super().__init__(message)


class Transport(Protocol):
    """Amit a :class:`Robot` egy transzporttól elvár.

    Egyetlen metódus: a parancs továbbítása a robothoz és a válasz
    visszaadása. A REST kliens (:class:`codie.api.CodieApi`) ezt adja, és
    a közvetlen BLE kliens is ugyanezt a szerződést teljesíti.
    """

    def command(self, name: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """Egy magas szintű parancs végrehajtása a robothoz."""
        ...


class Robot:
    """A robot magas szintű API-ja egy transzport fölött.

    Args:
        transport: a parancsokat továbbító transzport.
        address: a robot BLE-címe (a REST transzport ezt használja).
    """

    def __init__(self, transport: Transport, address: str | None = None) -> None:
        self.transport = transport
        self.address = address

    # --- érzékelők ---------------------------------------------------------

    def status(self) -> dict[str, Any]:
        """A robot teljes pillanatnyi állapota.

        Returns:
            ``{"batteryPct", "sonarMm", "lightRaw", "line", …}``.
        """
        return self.transport.command("status")["status"]

    def battery(self) -> int:
        """Akkumulátor töltöttségi szint (%)."""
        return int(self.transport.command("battery")["pct"])

    def sonar(self) -> int:
        """A szonár távolságértéke (mm)."""
        return int(self.transport.command("sonar")["mm"])

    def light(self) -> int:
        """A fényérzékelő nyers értéke (12 bit, 0 = legvilágosabb)."""
        return int(self.transport.command("light")["raw"])

    def line(self) -> dict[str, Any]:
        """A vonalérzékelő értéke.

        Returns:
            A routingos generációban ``{"left", "right"}``, a routing nélküli
            generációban ``{"value", "level", "onLine"}``.
        """
        return self.transport.command("line")["line"]

    def mic(self) -> int:
        """A mikrofon nyers erősségi értéke."""
        return int(self.transport.command("mic")["raw"])

    # --- aktuátorok --------------------------------------------------------

    def beep(self, ms: int = 500) -> dict[str, Any]:
        """Sípolás megadott időtartamig (ms, max 10000)."""
        return self.transport.command("beep", {"ms": int(ms)})

    def morse(self, text: str, unit_ms: int = 120) -> dict[str, Any]:
        """Szöveg Morse-kódként való kifejezése a csipogón."""
        return self.transport.command("morse", {"text": text, "unitMs": int(unit_ms)})

    def tune(self, name: str) -> dict[str, Any]:
        """Egy beépített ritmus lejátszása."""
        return self.transport.command("tune", {"name": name})

    def led(self, color: str) -> dict[str, Any]:
        """Minden LED egy színre állítása (színnév vagy ``#rrggbb``)."""
        return self.transport.command("led", {"color": color})

    def led_single(self, color: str, index: int) -> dict[str, Any]:
        """Egyetlen LED beállítása (1..12 — a routing nélküli generációban
        az összes LED színeződik, nincs egyedi címzés)."""
        return self.transport.command("ledSingle", {"color": color, "index": int(index)})

    def leds_off(self) -> dict[str, Any]:
        """Az összes LED kikapcsolása."""
        return self.transport.command("ledsOff")

    def led_anim(
        self,
        animation: int,
        color: str = "red",
        repeat: int = 0,
        speed: int = 10,
    ) -> dict[str, Any]:
        """Beépített LED-animáció lejátszása (0 vagy 1)."""
        return self.transport.command(
            "ledAnim",
            {
                "animation": int(animation),
                "color": color,
                "repeat": int(repeat),
                "speed": int(speed),
            },
        )

    # --- mozgás ------------------------------------------------------------

    def forward(self, cm: float = 10) -> dict[str, Any]:
        """Előrehaladás adott távolságra (cm, max 200)."""
        return self.transport.command("forward", {"cm": cm})

    def backward(self, cm: float = 10) -> dict[str, Any]:
        """Hátraállás adott távolságra (cm, max 200)."""
        return self.transport.command("backward", {"cm": cm})

    def turn(self, degrees: int) -> dict[str, Any]:
        """Helyben forgatás (pozitív fok = jobbra)."""
        return self.transport.command("turn", {"degrees": int(degrees)})

    def stop(self) -> dict[str, Any]:
        """Megállítás.

        A routing nélküli firmware **nem nyugtázza** a ``MOTOR_BOTH(0, 0)``
        parancsot, noha a robot megáll — ezért a hiányzó nyugta itt nem hiba,
        csak ``acknowledged: False`` a visszatérésben. A hívó így nem állhat
        meg egy félreértett hiba miatt, de a tényt látja.
        """
        try:
            result = self.transport.command("stop")
        except Exception as exc:  # noqa: BLE001 - a nyugta hiánya nem hiba
            message = str(exc)
            if "nem nyugtázta" not in message and "504" not in message:
                raise
            return {"action": "stop", "acknowledged": False}
        return {**result, "acknowledged": True}
