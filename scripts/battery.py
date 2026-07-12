#!/usr/bin/env python3
"""Akku állapot kiolvasása (SoC % + nyers feszültség), opcionálisan ismételve.

Használat:
    python scripts/battery.py [ismétlésszám] [késleltetés_mp]
Alap: 1 mérés. Pl. `battery.py 5 3` = 5 mérés 3 mp-enként (töltés-trend).
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
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    delay = float(sys.argv[2]) if len(sys.argv) > 2 else 3.0

    async with CodieClient(ADDRESS, adapter=ADAPTER) as c:
        for i in range(n):
            soc = await c.battery()
            volt = await c.battery_voltage()
            print(f"  #{i + 1}: SoC = {soc}%   feszültség (nyers) = {volt}")
            if i < n - 1:
                await asyncio.sleep(delay)


if __name__ == "__main__":
    asyncio.run(main())
