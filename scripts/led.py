#!/usr/bin/env python3
"""Egyetlen LED-parancs küldése — lépésenkénti teszteléshez.

Használat:
    python scripts/led.py <szín> [index]   # index 1..12 -> csak az az egy LED
    python scripts/led.py off              # összes LED le

Színek: white, green, red, blue, cyan, yellow, orange
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


async def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        return
    arg = sys.argv[1]
    index = int(sys.argv[2]) if len(sys.argv) > 2 else None

    async with CodieClient(ADDRESS, adapter=ADAPTER) as c:
        if arg == "off":
            r = await c.leds_off()
            print(f"LED-ek le. ack={r}")
        elif index is not None:
            r = await c.led_single(arg, index)
            h, s, v = p.color_hsv(arg)
            print(f"LED #{index} -> {arg} (HSV {h},{s},{v}). ack={r}")
        else:
            r = await c.led_all(arg)
            h, s, v = p.color_hsv(arg)
            print(f"mind a 12 LED -> {arg} (HSV {h},{s},{v}). ack={r}")


if __name__ == "__main__":
    asyncio.run(main())
