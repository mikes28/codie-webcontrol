"""Paritás-probe: a Python referencia-implementáció kimenete JSON-ban.

A `server/test/parity.test.js` ezt hasonlítja össze a JS porttal — bájtra
bájtra, hogy a port ne csússzon el a Python wire-protokolltól.

    python3 test/parity_probe.py
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent  # a repo gyökere


def _load(name: str, relative: str):
    path = ROOT / relative
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


p = _load("codie_protocol", "codie/protocol.py")
morse = _load("codie_morse", "codie/morse.py")
tunes = _load("codie_tunes", "codie/tunes.py")

p.reset_seq()

frames = []


def frame_of(cmd_id, args=b"", seq=None):
    frame, seq = p.build_frame(cmd_id, args, seq)
    frames.append(frame.hex())
    return seq


# --- frame-ek a megadott sorrendben (a JS teszt ugyanezt a sorrendet várja) ---

seqs = {}
seqs['beep'] = frame_of(p.CMD_SPEAK_BEEP, p.beep_args(1000))
seqs['beep_max'] = frame_of(p.CMD_SPEAK_BEEP, p.beep_args(99999))
seqs['battery'] = frame_of(p.CMD_BATTERY)
seqs['light'] = frame_of(p.CMD_LIGHT)
seqs['line'] = frame_of(p.CMD_LINE)
seqs['sonar'] = frame_of(p.CMD_SONAR)
seqs['mic'] = frame_of(p.CMD_MIC)
seqs['drive_speed'] = frame_of(p.CMD_DRIVE_SPEED, p.drive_speed_args(30, -30))
seqs['drive_distance'] = frame_of(p.CMD_DRIVE_DISTANCE, p.drive_distance_args(100, 30, 30))
seqs['drive_turn'] = frame_of(p.CMD_DRIVE_TURN, p.drive_turn_args(90, -40))
seqs['led_all_red'] = frame_of(p.CMD_LED_SET_COLOR, p.led_all_args("red"))
seqs['led_all_white'] = frame_of(p.CMD_LED_SET_COLOR, p.led_all_args("white"))
seqs['led_single_3'] = frame_of(p.CMD_LED_SET_COLOR, p.led_single_args("blue", 3))
seqs['led_single_12'] = frame_of(p.CMD_LED_SET_COLOR, p.led_single_args("orange", 12))
seqs['led_single_99'] = frame_of(p.CMD_LED_SET_COLOR, p.led_single_args("cyan", 99))
seqs['app_connected'] = frame_of(p.CMD_APP_CONNECTED)
seqs['app_disconnected'] = frame_of(p.CMD_APP_DISCONNECTED)

colors = {name: list(p.color_hsv(name)) for name in p.COLORS_RGB}

# --- válasz dekódolás ---

response_bytes = bytes([0x10, 0x2A, 0x00, 0x69, 0x10, 0x01, 0x00, 0x07, 0x00, 0x5A, 0x00])
decoded = p.decode_response(response_bytes)
decoded_out = None
if decoded is not None:
    decoded_out = {
        "seq": decoded["seq"],
        "cmd": decoded["cmd"],
        "arglen": decoded["arglen"],
        "reqSeq": decoded["req_seq"],
        "args": decoded["args"].hex(),
    }

short_decode = p.decode_response(bytes([0x10, 0x00]))

# --- Morse + ritmusok ---

morse_out = {
    text: morse.text_to_rhythm(text, unit)
    for text, unit in (("SOS", 120), ("hello world", 100), ("Codie 42", 60))
}

tunes_out = {name: [list(item) for item in pattern] for name, pattern in tunes.RHYTHMS.items()}

print(
    json.dumps(
        {
            "frames": frames,
            "seqs": seqs,
            "colors": colors,
            "decoded": decoded_out,
            "shortDecode": short_decode,
            "morse": morse_out,
            "tunes": tunes_out,
            "infoBytes": [
                p.info_byte(p.ROLE_APP, p.ROLE_MCU, p.PRIO_NORMAL),
                p.info_byte(p.ROLE_APP, p.ROLE_MCU, p.PRIO_HIGH),
                p.info_byte(p.ROLE_BROADCAST, p.ROLE_APP, p.PRIO_NORMAL),
            ],
            "responseArgPos": p.RESPONSE_ARG_POS,
            "maxBeepMs": p.MAX_BEEP_MS,
        },
        indent=2,
    )
)
