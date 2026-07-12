"""Codie MCP szerver.

A meglévő ``codie.CodieClient`` fölé tesz egy MCP réteget, hogy a Hermes Agent
(vagy bármely MCP-kliens) magas szintű, biztonságos toolokon át vezérelje a robotot.

Döntések:
  1. Egy tartós BLE-kapcsolat a szerver életére (nem per-hívás connect).
  2. Reconnect-wrapper: ha a kapcsolat megszakad (a robot elalszik / kimegy a
     hatótávból), a következő tool-hívás automatikusan újracsatlakozik.
  3. Csak véges, önmagukat korlátozó mozgásparancsok toolként -> nincs runaway.

Futtatás (stdio):
    CODIE_ADDRESS=DF:74:94:43:36:ED .venv/bin/python -m codie.mcp_server
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

from codie import CodieClient

load_dotenv()
ADDRESS = os.environ.get("CODIE_ADDRESS", "DF:74:94:43:36:ED")
ADAPTER = os.environ.get("CODIE_ADAPTER", "hci0")

COLORS = {"white", "green", "red", "blue", "cyan", "yellow", "orange"}

# DriveTurn (hivatalos API): pozitív speed -> BALRA fordul, negatív -> JOBBRA.
# Konvenció itt: pozitív fok = JOBBRA (óramutató járása). [élőben igazolandó]
_TURN_SPEED = 40
_DRIVE_SPEED = 40

_codie: CodieClient | None = None


async def _ensure() -> CodieClient:
    """A tartós kliens; ha a kapcsolat megszakadt, egyszer újracsatlakozik."""
    global _codie
    if _codie is not None and _codie.is_connected:
        return _codie
    if _codie is not None:
        try:
            await _codie.disconnect()
        except Exception:  # noqa: BLE001 - takarítás, a hibát elnyeljük
            pass
    _codie = CodieClient(ADDRESS, adapter=ADAPTER)
    await _codie.connect()
    return _codie


@asynccontextmanager
async def _lifespan(_server: "FastMCP"):
    """Lusta csatlakozás: a szerver azonnal indul, az első tool-hívás nyit BLE-kapcsolatot
    (a ``_ensure`` révén). Így a tool-felderítés nem vár a ~10-15 mp-es BLE connectre.
    Leálláskor bontunk."""
    global _codie
    try:
        yield
    finally:
        if _codie is not None:
            try:
                await _codie.disconnect()
            finally:
                _codie = None


mcp = FastMCP("codie", lifespan=_lifespan)


# ---- Érzékelés ("a Hermes szeme") -------------------------------------------

@mcp.tool()
async def status() -> dict:
    """A robot pillanatnyi állapota: akku (%), szonár (mm), fény- és vonalszenzor."""
    c = await _ensure()
    left, right = await c.line()
    return {
        "battery_pct": await c.battery(),
        "sonar_mm": await c.sonar(),
        "light": await c.light(),
        "line": {"left": left, "right": right},
    }


@mcp.tool()
async def look_ahead() -> int | None:
    """Szonár-távolság előre, mm-ben. Hívd meg mozgás ELŐTT akadály-ellenőrzésre."""
    c = await _ensure()
    return await c.sonar()


# ---- Mozgás (csak véges parancsok, magától megáll) --------------------------

@mcp.tool()
async def drive_forward(cm: float) -> str:
    """Előre halad adott távolságot (cm, 0..200). Véges parancs, magától megáll."""
    cm = max(0.0, min(cm, 200.0))
    c = await _ensure()
    await c.drive_distance(int(cm * 10), _DRIVE_SPEED, _DRIVE_SPEED)
    return f"előre {cm:g} cm"


@mcp.tool()
async def drive_backward(cm: float) -> str:
    """Hátra halad adott távolságot (cm, 0..200). Véges parancs, magától megáll."""
    cm = max(0.0, min(cm, 200.0))
    c = await _ensure()
    await c.drive_distance(int(cm * 10), -_DRIVE_SPEED, -_DRIVE_SPEED)
    return f"hátra {cm:g} cm"


@mcp.tool()
async def turn(degrees: float) -> str:
    """Fordul helyben. Pozitív fok = jobbra, negatív = balra. (max ±360°)"""
    magnitude = min(abs(int(degrees)), 360)
    # pozitív fok = jobbra -> az API szerint jobbra = NEGATÍV speed
    speed = -_TURN_SPEED if degrees >= 0 else _TURN_SPEED
    c = await _ensure()
    await c.drive_turn(magnitude, speed)
    return f"fordult {degrees:g}°"


@mcp.tool()
async def stop() -> str:
    """Azonnal megállítja a kerekeket."""
    c = await _ensure()
    await c.drive_speed(0, 0)
    return "megállt"


# ---- Kimenet (hang, fény) ---------------------------------------------------

@mcp.tool()
async def beep(ms: int = 500) -> str:
    """Sípol adott ideig (ms, max 10000)."""
    ms = max(1, min(ms, 10000))
    c = await _ensure()
    await c.beep(ms)
    return f"beep {ms} ms"


@mcp.tool()
async def say_morse(text: str) -> str:
    """A megadott szöveget Morse-kódként csipogja el."""
    c = await _ensure()
    await c.play_morse(text)
    return f"morse: {text}"


@mcp.tool()
async def set_leds(color: str) -> str:
    """Mind a 12 LED-et egy színre állítja. Színek: white, green, red, blue, cyan, yellow, orange."""
    color = color.lower()
    if color not in COLORS:
        return f"ismeretlen szín: {color}. választható: {', '.join(sorted(COLORS))}"
    c = await _ensure()
    await c.led_all(color)
    return f"LED-ek: {color}"


if __name__ == "__main__":
    mcp.run(transport="stdio")
