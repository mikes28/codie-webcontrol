"""Paritás-probe: a Python referencia-implementáció kimenete JSON-ban.

A `server/test/parity.test.js` ezt hasonlítja össze a JS portokkal — bájtra
bájtra, hogy a port ne csússzon el a Python wire-protokolltól.

    python3 test/parity_probe.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent  # a repo gyökere
sys.path.insert(0, str(ROOT))

from codie import morse, tunes  # noqa: E402
from codie import wire as p  # noqa: E402
from codie import wire_norrouting as np  # noqa: E402

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

# --- a routing nélküli generáció frame-jei és dekódolásai ---

nr_frames = [
    np.build_frame(np.CMD_MOTOR_BOTH, bytes([40, 40]), seq=1).hex(),
    np.build_frame(np.CMD_MOVE, np.u16(300) + bytes([30, 30]), seq=2).hex(),
    np.build_frame(np.CMD_TURN, np.u16(90) + bytes([40]), seq=3).hex(),
    np.build_frame(np.CMD_BEEP, bytes([100]) + np.u16(2000) + np.u16(500), seq=4).hex(),
    np.build_frame(np.CMD_SET_COLOR, bytes([10, 20, 30]), seq=5).hex(),
    np.build_frame(np.CMD_SET_ANIMATION, bytes([1, 10, 20, 30, 40]), seq=6).hex(),
    np.build_frame(np.QUERY_BATTERY, seq=7).hex(),
    np.build_frame(np.QUERY_DISTANCE, seq=8).hex(),
    np.build_frame(np.QUERY_SOUND, seq=9).hex(),
    np.build_frame(np.QUERY_LIGHT, seq=10).hex(),
    np.build_frame(np.QUERY_LINE, seq=11).hex(),
]

nr_replies = []
for payload in (bytes([0x61]), bytes([0x15, 0x00]), bytes([0x05, 0x07, 0x00, 0x00])):
    reply = np.decode_reply(bytes([0x01, 0x00]) + payload)
    nr_replies.append(
        {
            "seq": reply["seq"],
            "value": reply["value"],
            "payload": reply["payload"].hex(),
        }
    )

nr_line = np.decode_line(bytes([0x05, 0x07, 0x00, 0x00]))
nr_line_out = {"value": nr_line["value"], "level": nr_line["level"], "onLine": nr_line["onLine"]}

nr_colors = {name: list(np.color_params(name)) for name in p.COLORS_RGB}

nr_normalized = {
    "distance": [np.normalize_distance(raw) for raw in (0, 21, 25, 210, 1234)],
    "battery": [np.normalize_battery(raw) for raw in (0, 97, 100, 120)],
}

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
            "noRouting": {
                "frames": nr_frames,
                "replies": nr_replies,
                "line": nr_line_out,
                "colors": nr_colors,
                "normalized": nr_normalized,
            },
        },
        indent=2,
    )
)
