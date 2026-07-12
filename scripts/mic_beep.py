#!/usr/bin/env python3
"""Kísérlet: hallja-e a Codie a saját csipogását a mikrofonjával?

A mikrofon (MicGetRaw) ~50 ms-re átlagolt amplitúdót ad, BLE-n lekérdezve — ez
csak a hangerő-burkolóra elég, a frekvenciára (hangmagasság) NEM (Nyquist +
átlagolás). Ez a szkript ezt méréssel demonstrálja: alapzaj, majd beep közbeni
gyors mic-olvasások.

Használat: python scripts/mic_beep.py
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv  # noqa: E402

from codie import CodieClient  # noqa: E402
from codie import protocol as p  # noqa: E402

load_dotenv()
ADDRESS = os.environ.get("CODIE_ADDRESS", "DF:74:94:43:36:ED")
ADAPTER = os.environ.get("CODIE_ADAPTER", "hci0")


async def sample_mic(c: CodieClient, n: int) -> list[tuple[float, int]]:
    out: list[tuple[float, int]] = []
    t0 = time.monotonic()
    for _ in range(n):
        v = await c.mic()
        out.append((time.monotonic() - t0, v if v is not None else -1))
    return out


async def main() -> None:
    async with CodieClient(ADDRESS, adapter=ADAPTER) as c:
        print("Alapzaj (csend), 12 olvasás:")
        base = await sample_mic(c, 12)
        vals = [v for _, v in base if v >= 0]
        span = base[-1][0]
        rate = len(base) / span if span else 0
        avg = sum(vals) / len(vals) if vals else 0
        print(f"  átlag = {avg:.0f}   |   {span / len(base) * 1000:.0f} ms/olvasás   |   "
              f"effektív mintavétel ~{rate:.1f} Hz")
        print("  -> egy ~3 kHz csipogáshoz >6000 Hz kéne: kb. {:.0f}x túl lassú.".format(3000 / (rate or 1)))

        print("\n1500 ms beep indul, közben gyors mic-olvasások (burkoló):")
        await c._send(p.CMD_SPEAK_BEEP, p.beep_args(1500), expect_response=False)
        during = await sample_mic(c, 20)
        for t, v in during:
            bar = "#" * max(0, int(v / 40)) if v >= 0 else "(nincs)"
            print(f"  t={t * 1000:6.0f} ms   mic={v:5d}   {bar}")

        peak = max((v for _, v in during if v >= 0), default=0)
        print(f"\n  csúcs beep alatt = {peak}   |   alapzaj átlag = {avg:.0f}   "
              f"|   különbség = {peak - avg:.0f}")


if __name__ == "__main__":
    asyncio.run(main())
