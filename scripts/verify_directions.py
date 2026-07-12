#!/usr/bin/env python3
"""Mozgásirányok élő igazolása (előre/hátra, jobbra/balra fordulás).

A robot az OLDALÁN, TÖLTŐN feküdjön — a kerekek szabadon pörögnek, nem mozdul el.
Minden lépésnél kiírja, MIT kellene látni; te ellenőrzöd a kerékirányt.

Használat: python scripts/verify_directions.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv  # noqa: E402

from codie import CodieClient  # noqa: E402

load_dotenv()
ADDRESS = os.environ.get("CODIE_ADDRESS", "DF:74:94:43:36:ED")
ADAPTER = os.environ.get("CODIE_ADAPTER", "hci0")


async def main() -> None:
    async with CodieClient(ADDRESS, adapter=ADAPTER) as c:
        print("1) ELŐRE (mindkét kerék előre): drive_distance(150, +40, +40)")
        await c.drive_distance(150, 40, 40)
        await asyncio.sleep(2.0); await c.stop(); await asyncio.sleep(0.8)

        print("2) HÁTRA (mindkét kerék hátra): drive_distance(150, -40, -40)")
        await c.drive_distance(150, -40, -40)
        await asyncio.sleep(2.0); await c.stop(); await asyncio.sleep(0.8)

        print("3) MCP turn(+90) = 'jobbra': drive_turn(90, -40)  [API: negatív speed = jobbra]")
        await c.drive_turn(90, -40)
        await asyncio.sleep(2.0); await c.stop(); await asyncio.sleep(0.8)

        print("4) MCP turn(-90) = 'balra':  drive_turn(90, +40)  [API: pozitív speed = balra]")
        await c.drive_turn(90, 40)
        await asyncio.sleep(2.0); await c.stop()
        print("Kész.")


if __name__ == "__main__":
    asyncio.run(main())
