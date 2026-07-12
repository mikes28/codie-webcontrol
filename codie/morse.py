"""Morse-kód → ritmusminta a Codie fix-frekvenciás csipogójához.

A Codie hangszórója csak egyetlen hangmagasságon szól (lásd BLE API v1.0), de a
csipogások hosszát és a szüneteket vezérelhetjük — ez épp elég Morse-kódhoz.

Szabványos Morse időzítés egységekben (unit):
- pont ( . ) = 1 egység hang
- vonal ( - ) = 3 egység hang
- jelek közti szünet egy betűn belül = 1 egység
- betűk közti szünet = 3 egység
- szavak közti szünet = 7 egység
"""

from __future__ import annotations

MORSE: dict[str, str] = {
    "A": ".-", "B": "-...", "C": "-.-.", "D": "-..", "E": ".",
    "F": "..-.", "G": "--.", "H": "....", "I": "..", "J": ".---",
    "K": "-.-", "L": ".-..", "M": "--", "N": "-.", "O": "---",
    "P": ".--.", "Q": "--.-", "R": ".-.", "S": "...", "T": "-",
    "U": "..-", "V": "...-", "W": ".--", "X": "-..-", "Y": "-.--",
    "Z": "--..",
    "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-",
    "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
    ".": ".-.-.-", ",": "--..--", "?": "..--..", "'": ".----.",
    "!": "-.-.--", "/": "-..-.", "(": "-.--.", ")": "-.--.-",
    "&": ".-...", ":": "---...", ";": "-.-.-.", "=": "-...-",
    "+": ".-.-.", "-": "-....-", "_": "..--.-", '"': ".-..-.",
    "@": ".--.-.",
}


def text_to_rhythm(text: str, unit_ms: int = 120) -> list[tuple[int, int]]:
    """Szöveg -> [(csipogás_ms, szünet_ms), ...] Morse-ritmus.

    Az ismeretlen karaktereket kihagyja. A záró szünet 0 (nincs felesleges csend).
    """
    words = [w for w in text.upper().split() if w]
    pattern: list[tuple[int, int]] = []
    for wi, word in enumerate(words):
        chars = [c for c in word if c in MORSE]
        for ci, ch in enumerate(chars):
            code = MORSE[ch]
            for si, symbol in enumerate(code):
                beep = unit_ms * (3 if symbol == "-" else 1)
                if si < len(code) - 1:
                    gap = unit_ms          # jelek közt egy betűn belül
                elif ci < len(chars) - 1:
                    gap = unit_ms * 3      # betűk közt
                elif wi < len(words) - 1:
                    gap = unit_ms * 7      # szavak közt
                else:
                    gap = 0                # a legvégén nincs szünet
                pattern.append((beep, gap))
    return pattern
