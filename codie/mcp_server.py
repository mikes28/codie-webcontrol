"""Codie MCP szerver (vékony FastMCP burkoló).

A valódi logika a `codie.tools`-ben él; ez a modul csak a FastMCP regisztrációt
végzi. A `mcp` csomagot **csak** ez az egyetlen modul importálja — a `codie.tools`
és a `codie.api` a standard library-t használják, ezért azok (mint a tesztek is)
működnek anélk, hogy a `mcp` vagy a `bleak` fel lenne telepítve.
"""

from __future__ import annotations

try:
    from mcp.server.fastmcp import FastMCP
except ImportError as exc:  # mcp nélkül a szerver nem indulhat el
    raise ImportError(
        "A 'mcp' csomag szükséges a Codie MCP szerverhez, de nincs "
        "telepítve. Telepítse: pip install mcp"
    ) from exc

from dotenv import load_dotenv  # noqa: E402

from codie.tools import (  # noqa: E402
    tool_status,
    tool_look_ahead,
    tool_drive_forward,
    tool_drive_backward,
    tool_turn,
    tool_stop,
    tool_beep,
    tool_say_morse,
    tool_set_leds,
)

load_dotenv()

# A `CODIE_API_URL` / `CODIE_ADDRESS` a környezetből jön (get_api() kezeli).
mcp = FastMCP("codie")


# ---- Érzékelés ("a Hermes szeme") --------------------------------------------

@mcp.tool()
async def status() -> dict:
    """A robot pillanatnyi állapota: akku (%), szonár (mm), fény- és vonalszenzor."""
    return await tool_status()


@mcp.tool()
async def look_ahead() -> int | None:
    """Szonár-távolság előre, mm-ben. Hívd meg mozgás ELŐTT akadály-ellenőrzésre."""
    return await tool_look_ahead()


# ---- Mozgás (csak véges parancsok, magától megáll) --------------------------

@mcp.tool()
async def drive_forward(cm: float) -> str:
    """Előre halad adott távolságot (cm, 0..200). Véges parancs, magától megáll."""
    return await tool_drive_forward(cm)


@mcp.tool()
async def drive_backward(cm: float) -> str:
    """Hátra halad adott távolságot (cm, 0..200). Véges parancs, magától megáll."""
    return await tool_drive_backward(cm)


@mcp.tool()
async def turn(degrees: float) -> str:
    """Fordul helyben. Pozitív fok = jobbra, negatív = balra. (max ±360°)"""
    return await tool_turn(degrees)


@mcp.tool()
async def stop() -> str:
    """Azonnal megállítja a kerekeket."""
    return await tool_stop()


# ---- Kimenet (hang, fény) ---------------------------------------------------

@mcp.tool()
async def beep(ms: int = 500) -> str:
    """Sípol adott ideig (ms, max 10000)."""
    return await tool_beep(ms)


@mcp.tool()
async def say_morse(text: str) -> str:
    """A megadott szöveget Morse-kódként csipogja el."""
    return await tool_say_morse(text)


@mcp.tool()
async def set_leds(color: str, index: int | None = None) -> str:
    """Mind a 12 LED-et egy színre állítja. Színek: white, green, red, blue, cyan, yellow, orange."""
    return await tool_set_leds(color, index)


if __name__ == "__main__":
    mcp.run(transport="stdio")