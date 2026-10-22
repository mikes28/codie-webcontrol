"""Unit tesztek a BLE wire-protokollra — a robot nélkül futtatható.

    python -m unittest discover -s tests
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from codie import wire as p  # noqa: E402
from codie import wire_norrouting as np  # noqa: E402


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
        self.assertEqual(frame.hex(), "40010064100200e803")

    def test_sensor_request_has_zero_arglen(self):
        frame, _ = p.build_frame(p.CMD_BATTERY)
        # INFO=40, SEQ=01 00, CMD=69 10, ARGLEN=00 00
        self.assertEqual(frame.hex(), "40010069100000")
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
        self.assertEqual(p.beep_args(99999), p.u16(p.MAX_BEEP_MS))

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


class NoRoutingFrameTest(unittest.TestCase):
    """A routing nélküli generáció frame-formátuma (a robotunké)."""

    def test_frame_has_no_info_byte(self):
        # SEQ(2) | CMD(2, a magas bájt 0) | PARAM...
        frame = np.build_frame(np.CMD_MOTOR_BOTH, bytes([40, 40]), seq=7)
        self.assertEqual(frame.hex(), "070002002828")

    def test_query_frame_is_seq_plus_cmd(self):
        frame = np.build_frame(np.QUERY_BATTERY, seq=1)
        self.assertEqual(frame.hex(), "01000200")

    def test_reply_decodes_the_variable_length_value(self):
        # SEQ(2) | VALUE(1 byte) — az akku válasza 1 bájtos
        reply = np.decode_reply(bytes([0x01, 0x00, 0x61]))
        self.assertEqual(reply["seq"], 1)
        self.assertEqual(reply["value"], 0x61)
        self.assertEqual(reply["payload"], bytes([0x61]))

    def test_reply_decodes_a_four_byte_line_value(self):
        payload = bytes([0x05, 0x07, 0x00, 0x00])
        reply = np.decode_reply(bytes([0x01, 0x00]) + payload)
        self.assertEqual(reply["value"], int.from_bytes(payload, "little"))

    def test_short_reply_is_none(self):
        self.assertIsNone(np.decode_reply(bytes([0x01, 0x00])))

    def test_distance_is_tenths_of_a_millimetre(self):
        self.assertEqual(np.normalize_distance(210), 21)

    def test_distance_rounds_half_up_like_javascript(self):
        # a JS Math.round(2.5) = 3, a Python round(2.5) = 2 — ez itt nem lehet
        self.assertEqual(np.normalize_distance(25), 3)

    def test_battery_is_capped_at_hundred(self):
        self.assertEqual(np.normalize_battery(120), 100)
        self.assertEqual(np.normalize_battery(97), 97)

    def test_line_value_is_one_fixed_point_number(self):
        payload = bytes([0x05, 0x07, 0x00, 0x00])
        line = np.decode_line(payload)
        self.assertEqual(line["value"], 0x00000705)
        self.assertFalse(line["onLine"])

    def test_line_on_line_above_the_threshold(self):
        payload = (40 * np.LINE_SCALE).to_bytes(4, "little")
        line = np.decode_line(payload)
        self.assertTrue(line["onLine"])

    def test_color_uses_the_firmware_scale(self):
        # a routing nélküli firmware: hue 0..360 ×0,7; sat/val 0..100 ×2,55
        self.assertEqual(np.color_params("red"), (0, 255, 255))
        self.assertEqual(np.color_params("white"), (0, 0, 255))


if __name__ == "__main__":
    unittest.main()
