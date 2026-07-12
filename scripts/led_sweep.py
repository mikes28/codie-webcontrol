#!/usr/bin/env python3
"""Lassú LED szín-szekvencia — kényelmes vizuális ellenőrzéshez.

Végigmegy a 7 színen (mind a 12 LED), majd egyesével körbe, végül zöld.
Minden szín tartása alapból 2.5 mp.

FONTOS: a robot legyen LEVÉVE a töltőről — töltés közben a firmware saját
LED-animációja felülírja ezeket a színeket.

Használat:
    python scripts/led_sweep.py [tartás_mp]
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv  # noqa: E402

from codie import CodieClient  # noqa: E402
from codie import protocol as p  # noqa: E402

load_dotenv()
ADDRESS = os.environ.get("CODIE_ADDRESS", "DF:74:94:43:36:ED")
ADAPTER = os.environ.get("CODIE_ADAPTER", "hci0")

COLORS = ["red", "green", "blue", "yellow", "cyan", "orange", "white"]


async def main() -> None:
    hold = float(sys.argv[1]) if len(sys.argv) > 1 else 2.5

    async with CodieClient(ADDRESS, adapter=ADAPTER) as c:
        print("Mind a 12 LED, színenként:")
        for color in COLORS:
            h, s, v = p.color_hsv(color)
            r = await c.led_all(color)
            ok = "OK" if r and r.get("args") == b"\x00" else str(r)
            print(f"  {color:7s} (HSV {h},{s},{v})  ack={ok}")
            await asyncio.sleep(hold)

        print("Egyesével körbe (kék, #1..#12):")
        await c.leds_off()
        await asyncio.sleep(0.4)
        for i in range(1, 13):
            await c.led_single("blue", i)
            print(f"  LED #{i}")
            await asyncio.sleep(0.4)

        await asyncio.sleep(0.5)
        await c.led_all("green")
        print("Vége — vissza zöldre.")


if __name__ == "__main__":
    asyncio.run(main())
