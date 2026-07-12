#!/usr/bin/env python3
"""Codie teljes funkció-teszt harness.

Használat:
    python scripts/test_all.py [szekció ...]

Szekciók: sensors, beep, led, drive, all (alap: all)
A cím/adapter a .env-ből (CODIE_ADDRESS, CODIE_ADAPTER), vagy env-változóból.

A robot az oldalán, töltőn feküdjön — így a mozgásteszteknél a kerekek
szabadon pörögnek, de a robot nem szalad le az asztalról.
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


def hx(data: bytes) -> str:
    return " ".join(f"{b:02x}" for b in data)


async def test_sensors(c: CodieClient) -> None:
    print("\n=== SZENZOROK (objektív adat a notify-csatornán) ===")
    battery = await c.battery()
    print(f"  akku (SoC)      : {battery}%" if battery is not None else "  akku            : nincs válasz")
    light = await c.light()
    print(f"  fény (raw)      : {light}" if light is not None else "  fény            : nincs válasz")
    line = await c.line()
    print(f"  vonal (bal,jobb): {line}" if line else "  vonal           : nincs válasz")
    sonar = await c.sonar()
    print(f"  szonár (mm)     : {sonar}" if sonar is not None else "  szonár          : nincs válasz")
    mic = await c.mic()
    print(f"  mikrofon (raw)  : {mic}" if mic is not None else "  mikrofon        : nincs válasz")


async def test_beep(c: CodieClient) -> None:
    print("\n=== BEEP (figyelj: rövid sípszó) ===")
    r = await c.beep(700)
    print(f"  beep 700ms elküldve; válasz: {r}")


async def test_led(c: CodieClient) -> None:
    print("\n=== LED (figyeld a 12 LED színét) ===")
    for color in ["red", "green", "blue", "yellow", "cyan", "orange", "white"]:
        h, s, v = p.color_hsv(color)
        await c.led_all(color)
        print(f"  mind a 12 LED -> {color:7s} (HSV {h},{s},{v})")
        await asyncio.sleep(0.8)
    print("  --- egyesével körbe (index 1..12, kék) ---")
    await c.leds_off()
    for i in range(1, 13):
        await c.led_single("blue", i)
        print(f"  LED #{i} -> blue")
        await asyncio.sleep(0.25)
    await asyncio.sleep(0.5)
    await c.led_all("green")
    print("  vissza zöldre.")


async def test_drive(c: CodieClient) -> None:
    print("\n=== MOZGÁS (a kerekek pörögnek — robot az oldalán, töltőn!) ===")
    print("  DriveSpeed: mindkét kerék előre 30% ~1.5s")
    await c.drive_speed(30, 30)
    await asyncio.sleep(1.5)
    await c.stop()
    print("  stop.")
    await asyncio.sleep(0.6)

    print("  DriveSpeed: ellentétes (bal 30, jobb -30) ~1.5s — helyben fordulás")
    await c.drive_speed(30, -30)
    await asyncio.sleep(1.5)
    await c.stop()
    print("  stop.")
    await asyncio.sleep(0.6)

    print("  DriveDistance: 100mm, 30% mindkét kerék")
    r = await c.drive_distance(100, 30, 30)
    print(f"    válasz: {r}")
    await asyncio.sleep(1.5)
    await c.stop()

    print("  DriveTurn: 90 fok, 30%")
    r = await c.drive_turn(90, 30)
    print(f"    válasz: {r}")
    await asyncio.sleep(1.5)
    await c.stop()
    print("  stop.")


SECTIONS = {
    "sensors": test_sensors,
    "beep": test_beep,
    "led": test_led,
    "drive": test_drive,
}


async def main() -> None:
    requested = sys.argv[1:] or ["all"]
    if "all" in requested:
        order = ["sensors", "beep", "led", "drive"]
    else:
        order = [s for s in ["sensors", "beep", "led", "drive"] if s in requested]

    print(f"Csatlakozás: {ADDRESS} (adapter {ADAPTER}) ...")
    async with CodieClient(ADDRESS, adapter=ADAPTER) as c:
        print(f"Kapcsolódva: {c.is_connected}")
        for name in order:
            await SECTIONS[name](c)

        print("\n=== ÖSSZES NYERS NOTIFY ===")
        if not c.notifications:
            print("  (nem érkezett notify)")
        for raw, resp in c.notifications:
            extra = ""
            if resp:
                extra = f"  cmd=0x{resp['cmd']:04x} reqseq={resp['req_seq']} args={hx(resp['args'])}"
            print(f"  {hx(raw)}{extra}")


if __name__ == "__main__":
    asyncio.run(main())
