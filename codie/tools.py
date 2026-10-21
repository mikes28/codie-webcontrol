"""Codie MCP-eszközök logikája a JS backend REST API felé.

A valódi BLE réteg a Node.js backendben (`server/`) él; a Python oldalon csak az
HTTP felületet kezeli. Ez a modul a `codie.api.CodieApi` szinkron kliensét használja,
a blokkoló `urllib` hívásokat pedig `asyncio.to_thread`-vel futtatja, hogy ne
akassza meg a FastMCP esemélyloop-ot.

Megjegyzés: a `mcp` csomagot **csak** a `codie.mcp_server` importálja. Ez a modul
csak a standard library-t használ a `codie.api`-n keresztül, ezért `import codie.tools`
— és a tesztek is — működik anélk, hogy a `mcp` vagy a `bleak` fel lenne telepítve.
"""

from __future__ import annotations

import asyncio

from codie.api import CodieApi, CodieApiError

# Modul-szintű Codie REST API kliens. A tesztek a `set_api()`-val injektálják
# a stub-klienst, így a valódi hálózat meg sem hívja.
api: CodieApi | None = None


def get_api() -> CodieApi:
    """Visszaadja a használandó CodieApi-t; ha még nincs, a környezetből építi.

    A `CODIE_API_URL` / `CODIE_ADDRESS` környezeti változók alapján konstruálja
    a klienst (lásd `codie.api.CodieApi`).
    """
    global api
    if api is None:
        api = CodieApi()
    return api


def set_api(new_api: CodieApi | None) -> None:
    """Cseréli vagy töröli a modul-szintű CodieApi-t — például a teszteknek."""
    global api
    api = new_api


# ---- Érzékelés ("a Hermes szeme") --------------------------------------------

async def tool_status() -> dict:
    """A robot pillanatnyi állapota: akku (%), szonár (mm), fény- és vonalszenzor."""
    return await asyncio.to_thread(get_api().status)


async def tool_look_ahead() -> int | None:
    """Szonár-távolság előre, mm-ben. Hívd meg mozgás ELŐTT akadály-ellenőrzésre."""
    try:
        return await asyncio.to_thread(get_api().sonar)
    except CodieApiError as exc:
        # 504 = a robot felcsatolt, de a szonár nem válaszol → nem mérhető.
        # Más hiba (pl. nincs csatlakoztatva) a FastMCP felé továbbadódik.
        if exc.status == 504:
            return None
        raise


# ---- Mozgás (csak véges parancsok, magától megáll) --------------------------

async def tool_drive_forward(cm: float) -> str:
    """Előre halad adott távolságot (cm, 0..200). Véges parancs, magától megáll."""
    await asyncio.to_thread(get_api().forward, cm)
    return f"előre {cm:g} cm"


async def tool_drive_backward(cm: float) -> str:
    """Hátra halad adott távolságot (cm, 0..200). Véges parancs, magától megáll."""
    await asyncio.to_thread(get_api().backward, cm)
    return f"hátra {cm:g} cm"


async def tool_turn(degrees: float) -> str:
    """Fordul helyben. Pozitív fok = jobbra, negatív = balra. (max ±360°)"""
    await asyncio.to_thread(get_api().turn, degrees)
    return f"fordult {degrees:g}°"


async def tool_stop() -> str:
    """Azonnal megállítja a kerekeket."""
    await asyncio.to_thread(get_api().stop)
    return "megállt"


# ---- Kimenet (hang, fény) ---------------------------------------------------

async def tool_beep(ms: int = 500) -> str:
    """Sípol adott ideig (ms, max 10000)."""
    await asyncio.to_thread(get_api().beep, ms)
    return f"beep {ms} ms"


async def tool_say_morse(text: str) -> str:
    """A megadott szöveget Morse-kódként csipogja el."""
    await asyncio.to_thread(get_api().morse, text)
    return f"morse: {text}"


async def tool_set_leds(color: str, index: int | None = None) -> str:
    """Mind a 12 LED-et egy színre állítja. Színek: white, green, red, blue, cyan, yellow, orange."""
    color = color.lower()
    if index is None:
        await asyncio.to_thread(get_api().led, color)
        return f"LED-ek: {color}"
    await asyncio.to_thread(get_api().command, "ledSingle", {"color": color, "index": index})
    return f"LED {index}: {color}"