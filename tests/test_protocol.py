"""Unit tesztek a wire-protokollra — a robot nélkül futtatható.

    python -m unittest discover -s tests
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from codie import protocol as p  # noqa: E402


class InfoByteTest(unittest.TestCase):
    def test_app_to_mcu_normal(self):
        # (APP=0 << 4) | (MCU=1 << 6) | NORMAL = 0x40
        self.assertEqual(p.info_byte(p.ROLE_APP, p.ROLE_MCU, p.PRIO_NORMAL), 0x40)

    def test_high_prio_sets_bit(self):
        self.assertEqual(p.info_byte(p.ROLE_APP, p.ROLE_MCU, p.PRIO_HIGH), 0x48)


class FrameTest(unittest.TestCase):
    def setUp(self):
        p.reset_seq()

    def test_beep_frame_matches_verified_bytes(self):
        # A 2026-07-07-én élőben igazolt beep frame: 40 01 00 64 10 02 00 e8 03
        frame, seq = p.build_frame(p.CMD_SPEAK_BEEP, p.beep_args(1000))
        self.assertEqual(seq, 1)
        self.assertEqual(frame.hex(), "400100641002 00e803".replace(" ", ""))

    def test_sensor_request_has_zero_arglen(self):
        frame, _ = p.build_frame(p.CMD_BATTERY)
        # INFO=40, SEQ=01 00, CMD=69 10, ARGLEN=00 00
        self.assertEqual(frame.hex(), "4001006910 0000".replace(" ", ""))
        self.assertEqual(len(frame), 7)

    def test_seq_increments_and_wraps(self):
        p.reset_seq()
        _, s1 = p.build_frame(p.CMD_MIC)
        _, s2 = p.build_frame(p.CMD_MIC)
        self.assertEqual((s1, s2), (1, 2))

    def test_arglen_reflects_args(self):
        frame, _ = p.build_frame(p.CMD_DRIVE_DISTANCE, p.drive_distance_args(100, 30, 30))
        # distance u16 (100=0x64) + left i8 (30=0x1e) + right i8 (30=0x1e) => 4 byte
        self.assertEqual(frame[5], 4)
        self.assertEqual(frame[7:], bytes([0x64, 0x00, 0x1E, 0x1E]))


class ArgEncodingTest(unittest.TestCase):
    def test_i8_negative(self):
        # -30 két-komplemens = 0xE2 (hátramenet / ellenkező kerék)
        self.assertEqual(p.drive_speed_args(30, -30), bytes([0x1E, 0xE2]))

    def test_beep_clamped_to_max(self):
        self.assertEqual(p.beep_args(99999), p._u16(p.MAX_BEEP_MS))

    def test_led_single_mask(self):
        # index 1 -> mask 0x0001 ; index 12 -> 0x0800
        self.assertEqual(p.led_single_args("red", 1)[:2], bytes([0x01, 0x00]))
        self.assertEqual(p.led_single_args("red", 12)[:2], bytes([0x00, 0x08]))

    def test_led_all_mask_is_12_bits(self):
        self.assertEqual(p.led_all_args("green")[:2], bytes([0xFF, 0x0F]))


class ColorTest(unittest.TestCase):
    def test_primary_hues(self):
        # Hivatalos Codie BLE API v1.0: HSV 0-255 skálán.
        self.assertEqual(p.color_hsv("red"), (0, 255, 255))
        self.assertEqual(p.color_hsv("green"), (85, 255, 255))
        self.assertEqual(p.color_hsv("blue"), (170, 255, 255))
        self.assertEqual(p.color_hsv("white"), (0, 0, 255))

    def test_unknown_color_raises(self):
        with self.assertRaises(ValueError):
            p.color_hsv("mauve")


class ResponseDecodeTest(unittest.TestCase):
    def test_decode_battery_response(self):
        # INFO, SEQ(2), CMD(2 MSB set: 69 90), ARGLEN(2)=01 00, REQSEQ(2)=05 00, ARG=soc(0x55=85%)
        raw = bytes([0x10, 0x0A, 0x00, 0x69, 0x90, 0x01, 0x00, 0x05, 0x00, 0x55])
        resp = p.decode_response(raw)
        self.assertEqual(resp["cmd"], p.CMD_BATTERY)
        self.assertEqual(resp["req_seq"], 5)
        self.assertEqual(p.read_u8(resp["args"], 0), 0x55)

    def test_decode_sonar_u16(self):
        raw = bytes([0x10, 0x0A, 0x00, 0x63, 0x90, 0x02, 0x00, 0x07, 0x00, 0x2C, 0x01])
        resp = p.decode_response(raw)
        self.assertEqual(p.read_u16(resp["args"], 0), 0x012C)  # 300 mm

    def test_short_packet_returns_none(self):
        self.assertIsNone(p.decode_response(bytes([0x10, 0x00])))


if __name__ == "__main__":
    unittest.main()
