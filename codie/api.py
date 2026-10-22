"""Codie REST API kliens — szinkron, standard library alapú.

A Codie robot BLE vezérlése a Node.js backend (BlueZ / noble) révén történik.
Ez a modul a **kapcsati (gateway) réteg**: a valódi BLE kommunikációért a
backend felel, a Python oldal az HTTP felületet kezeli. Nincs szükség
``bleak``-ra vagy bármelyik más külső csomagra — kizárólag a standard
library-t használja.

A magas szintű robot-API a :class:`codie.robot.Robot`; ez a modul a
transzport, amit az kap.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .robot import Robot

__all__ = ["CodieApiError", "CodieApi"]


class CodieApiError(RuntimeError):
    """Hiba a Codie REST API hívások során.

    Attributes:
        status: HTTP státuszkód (4xx/5xx), vagy 0 hálózati/összeköttetési hiba esetén.
        message: a hiba részletes leírása; ``str(error)`` is ezt adja vissza.
    """

    def __init__(self, status: int, message: str) -> None:
        self.status: int = status
        self.message: str = message
        super().__init__(message)


class CodieApi:
    """Szinkron REST kliens a Codie Node.js backendhez.

    A ``base_url`` és ``address`` alapértékei a ``CODIE_API_URL`` és
    ``CODIE_ADDRESS`` környezeti változókból jönnek — de a **kezdetlegesen
    átadott argumentum győz** felettük (különben egy beállított env-változó
    elrejtené a hívó szándékát, pl. a teszt mock szerverét).

    Az osztály transzport: a :class:`codie.robot.Robot` ezen keresztül szól a
    robothoz.
    """

    def __init__(
        self,
        base_url: str | None = None,
        address: str | None = None,
        timeout: float = 10.0,
    ) -> None:
        self.base_url: str = (
            base_url or os.environ.get("CODIE_API_URL") or "http://127.0.0.1:3000"
        )
        self.address: str | None = address or os.environ.get("CODIE_ADDRESS") or None
        self.timeout: float = timeout

    # --- Szkéma segédek ----------------------------------------------------

    def _url(self, path: str) -> str:
        """Teljes URL összeállítása a base_url és a relatív path-ból."""
        return f"{self.base_url.rstrip('/')}{path}"

    @staticmethod
    def _enc(addr: str) -> str:
        """MAC-cím URL-kódolása (a `:`-ek %3A-ra vannak kódolva)."""
        return urllib.parse.quote(addr, safe="")

    def _request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> Any:
        """HTTP kérés küldése és JSON válasz visszafeldolgozása.

        POST esetén ``Content-Type: application/json`` fejlécet állít be,
        és a ``timeout``-ot a ``urlopen``-nak átadja.

        Raises:
            CodieApiError: HTTP hiba (4xx/5xx) vagy hálózati hiba esetén.
                A hiba ``status`` a HTTP kódot (vagy 0-t hálózati hibáknál) tartalmazza.
        """
        headers: dict[str, str] = {}
        data: bytes | None = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(
            self._url(path), data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", errors="replace")
            e.close()
            try:
                detail: Any = json.loads(raw).get("error", raw)
            except (ValueError, AttributeError):
                detail = raw
            raise CodieApiError(e.code, str(detail)) from e
        except urllib.error.URLError as e:
            raise CodieApiError(0, str(e)) from e

    # --- a transzport felülete ---------------------------------------------

    def command(
        self,
        name: str,
        params: dict[str, Any] | None = None,
        address: str | None = None,
    ) -> dict[str, Any]:
        """Magas szintű parancs küldése a robotnak.

        A ``POST /api/robots/:address/command`` végpontra ``{name, params}`` body-t küld.
        Ha ``address`` nincs megadva, ``resolve_address()`` választja a
        csatlakoztatott robotot. A visszatérési érték a backend
        ``{address, action, …}`` válasza.

        Raises:
            CodieApiError: HTTP vagy hálózati hiba esetén.
        """
        if address is None:
            address = self.address or self.resolve_address()
        body: dict[str, Any] = {"name": name}
        if params is not None:
            body["params"] = params
        return self._request(
            "POST",
            f"/api/robots/{self._enc(address)}/command",
            body,
        )

    # --- a robot kezelése --------------------------------------------------

    def health(self) -> dict[str, Any]:
        """``GET /api/health`` → ``{ ok, robots }`` (a csatlakoztatott robotok száma)."""
        return self._request("GET", "/api/health")

    def robots(self) -> list[dict[str, Any]]:
        """``GET /api/robots`` → a robotleírások listája (a ``robots`` kulcs tartalma)."""
        resp = self._request("GET", "/api/robots")
        return resp.get("robots", [])

    def robot(self, address: str) -> dict[str, Any]:
        """``GET /api/robots/:address`` → egy robot részletes leírása."""
        return self._request("GET", f"/api/robots/{self._enc(address)}")

    def telemetry(self, address: str | None = None) -> dict[str, Any]:
        """``GET /api/robots/:address/telemetry`` → a legutóbbi szenzoradatok."""
        if address is None:
            address = self.address or self.resolve_address()
        return self._request("GET", f"/api/robots/{self._enc(address)}/telemetry")

    def connect(self, address: str) -> dict[str, Any]:
        """``POST /api/robots/:address/connect`` → a csatlakoztatott robot leírása."""
        return self._request("POST", f"/api/robots/{self._enc(address)}/connect")

    def disconnect(self, address: str) -> dict[str, Any]:
        """``POST /api/robots/:address/disconnect`` → a leválasztott robot leírása."""
        return self._request(
            "POST", f"/api/robots/{self._enc(address)}/disconnect"
        )

    def resolve_address(self) -> str:
        """Az első csatlakoztatott (``connected``) robot MAC-címe.

        Raises:
            CodieApiError(409, …): ha nincs csatlakoztatott robot.
        """
        for robot in self.robots():
            if robot.get("connected"):
                return robot["address"]
        raise CodieApiError(
            409,
            "Nincs csatlakoztatott robot — csatlakozzon előbb egyhez "
            "a /api/robots/:address/connect végpontra!",
        )

    # --- a magas szintű API (a Robot réteg delegálásával) -----------------

    @property
    def robot_api(self) -> Robot:
        """A :class:`codie.robot.Robot` példány ezen a transzporton."""
        return Robot(self, self.address)

    def status(self) -> dict[str, Any]:
        """A robot teljes pillanatnyi állapota: akku %, szonár mm, fény, vonal."""
        return self.robot_api.status()

    def battery(self) -> int:
        """Akkumulátor töltöttségi szint (%)."""
        return self.robot_api.battery()

    def sonar(self) -> int:
        """Szonár-érzékelő értéke (mm-ben)."""
        return self.robot_api.sonar()

    def light(self) -> int:
        """Fényérzékelő nyers értéke (12 bit, 0 = legvilágosabb)."""
        return self.robot_api.light()

    def line(self) -> dict[str, Any]:
        """Vonalkövető érzékelő: ``{ value, level, onLine }`` vagy ``{ left, right }``."""
        return self.robot_api.line()

    def mic(self) -> int:
        """Mikrofon nyers értéke."""
        return self.robot_api.mic()

    def beep(self, ms: int = 500) -> dict[str, Any]:
        """Sípolás megadott időtartamig (ms, max 10000)."""
        return self.robot_api.beep(ms)

    def morse(self, text: str, unit_ms: int = 120) -> dict[str, Any]:
        """Szöveg Morse-kódként való kifejezése a csipogón."""
        return self.robot_api.morse(text, unit_ms)

    def tune(self, name: str) -> dict[str, Any]:
        """Előre definiált ritmus (dallam) lejátszása."""
        return self.robot_api.tune(name)

    def led(self, color: str) -> dict[str, Any]:
        """Minden LED egy színre állítása (pl. 'red', 'white', 'green')."""
        return self.robot_api.led(color)

    def led_anim(self, animation: int, color: str = "red") -> dict[str, Any]:
        """Beépített LED-animáció lejátszása (0 vagy 1)."""
        return self.robot_api.led_anim(animation, color)

    def forward(self, cm: int = 10) -> dict[str, Any]:
        """Lineáris előrehaladás (cm, 0..200)."""
        return self.robot_api.forward(cm)

    def backward(self, cm: int = 10) -> dict[str, Any]:
        """Lineáris hátraállás (cm, 0..200)."""
        return self.robot_api.backward(cm)

    def turn(self, degrees: int) -> dict[str, Any]:
        """Fordulás helyben. Pozitív fok = jobbra, negatív = balra."""
        return self.robot_api.turn(degrees)

    def stop(self) -> dict[str, Any]:
        """Azonnali megállítás minden mozgásban lévő robotnál."""
        return self.robot_api.stop()
