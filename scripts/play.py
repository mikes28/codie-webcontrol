#!/usr/bin/env python3
"""Ritmus / Morse lejátszása a Codie csipogójával.

Használat:
    python scripts/play.py morse "SOS"           # szöveg Morse-kódban
    python scripts/play.py morse "HELLO" 100      # egyedi egység (ms)
    python scripts/play.py tune shave_haircut     # beépített ritmus
    python scripts/play.py list                   # elérhető ritmusok
    python scripts/play.py beep 300               # egyszeri csipogás

A csipogást a töltés NEM írja felül, így töltőn is hallható.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv  # noqa: E402

from codie import CodieClient  # noqa: E402
from codie import tunes  # noqa: E402

load_dotenv()
ADDRESS = os.environ.get("CODIE_ADDRESS", "DF:74:94:43:36:ED")
ADAPTER = os.environ.get("CODIE_ADAPTER", "hci0")


async def main() -> None:
    args = sys.argv[1:]
    if not args or args[0] == "list":
        print("Elérhető ritmusok:", ", ".join(tunes.names()))
        if not args:
            print(__doc__)
        return

    mode = args[0]
    async with CodieClient(ADDRESS, adapter=ADAPTER) as c:
        if mode == "morse":
            text = args[1] if len(args) > 1 else "SOS"
            unit = int(args[2]) if len(args) > 2 else 120
            print(f"Morse: {text!r} (egység {unit} ms)")
            await c.play_morse(text, unit)
        elif mode == "tune":
            name = args[1] if len(args) > 1 else "shave_haircut"
            print(f"Ritmus: {name}")
            await c.play_tune(name)
        elif mode == "beep":
            ms = int(args[1]) if len(args) > 1 else 300
            print(f"Beep: {ms} ms")
            await c.beep(ms)
        else:
            print(__doc__)


if __name__ == "__main__":
    asyncio.run(main())
