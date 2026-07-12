"""Előre beépített ritmusminták a Codie csipogójához.

Mivel a hangmagasság fix, ezek nem dallamok, hanem felismerhető *ritmusok*.
Minden minta: [(csipogás_ms, szünet_ms), ...].
"""

from __future__ import annotations

RHYTHMS: dict[str, list[tuple[int, int]]] = {
    # "Shave and a haircut... two bits!"
    "shave_haircut": [
        (180, 110), (110, 110), (110, 110), (180, 260), (200, 450),
        (200, 130), (240, 0),
    ],
    # Beethoven 5. – "ta-ta-ta-TAAA" (kétszer)
    "beethoven5": [
        (140, 90), (140, 90), (140, 90), (520, 500),
        (140, 90), (140, 90), (140, 90), (520, 0),
    ],
    # Szívdobbanás: lub-dub ... lub-dub ...
    "heartbeat": [
        (70, 60), (110, 650), (70, 60), (110, 650),
        (70, 60), (110, 0),
    ],
    # Rövid győzelmi/figyelemfelkeltő pittyegés
    "tada": [(90, 60), (90, 60), (420, 0)],
    # Riasztás: gyors, sürgető pittyek
    "alarm": [(120, 90)] * 8,
    # Visszaszámlálás: három rövid, egy hosszú
    "countdown": [(120, 700), (120, 700), (120, 700), (500, 0)],
}


def names() -> list[str]:
    return sorted(RHYTHMS)
