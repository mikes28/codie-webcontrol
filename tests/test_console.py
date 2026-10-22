"""Unit tesztek a visszafejtett firmware parancsnyelvére.

A referencia a C implementáció (``fw/modules/proxy.c``) — a teszt azt
ellenőrzi, hogy a Python port byte-exakt: ugyanaz a grammatika, ugyanaz a
válaszforma, ugyanaz a számrendszer.

    python -m unittest discover -s tests
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from codie import console as c  # noqa: E402


class RequestTest(unittest.TestCase):
    def test_build_request_joins_the_parts(self):
        self.assertEqual(c.build_request("get", "hwiAdc", "buf"), "get hwiAdc buf")

    def test_build_request_keeps_the_arguments(self):
        self.assertEqual(
            c.build_request("set", "hwiDrive", "dutyA", "1e"), "set hwiDrive dutyA 1e"
        )

    def test_build_request_rejects_an_unknown_verb(self):
        with self.assertRaises(c.ProtocolError):
            c.build_request("put", "hwiAdc", "buf")

    def test_parse_request_splits_the_line(self):
        command = c.parse_request("get hwiLine read 1")
        self.assertEqual(command.verb, "get")
        self.assertEqual(command.interface, "hwiLine")
        self.assertEqual(command.op, "read")
        self.assertEqual(command.args, ("1",))

    def test_parse_request_rejects_a_malformed_line(self):
        # a firmware erre "Invalid command!" hibát küld
        for line in ("", "get", "get hwiAdc", "frobnicate hwiAdc buf"):
            with self.assertRaises(c.ProtocolError):
                c.parse_request(line)

    def test_command_round_trip(self):
        line = "call appSys hwInit"
        self.assertEqual(c.Command.parse(line).line(), line)

    def test_the_command_buffer_is_forty_bytes(self):
        self.assertEqual(c.CMD_BUF_SIZE, 40)


class ReplyTest(unittest.TestCase):
    def test_value_reply(self):
        reply = c.parse_reply("get hwiMic level 1f4")
        self.assertEqual(reply.kind, "value")
        self.assertEqual(reply.verb, "get")
        self.assertEqual(reply.interface, "hwiMic")
        self.assertEqual(reply.op, "level")
        self.assertEqual(reply.value, "1f4")

    def test_value_reply_without_a_value(self):
        reply = c.parse_reply("set drvBattery hwInit")
        self.assertEqual(reply.kind, "value")
        self.assertIsNone(reply.value)

    def test_system_message(self):
        reply = c.parse_reply("call :proxy message err No interface:hwiFoo")
        self.assertEqual(reply.kind, "message")
        self.assertEqual(reply.level, "err")
        self.assertEqual(reply.text, "No interface:hwiFoo")
        self.assertTrue(reply.is_error)

    def test_system_message_with_a_multi_word_text(self):
        reply = c.parse_reply("call :proxy message wrn BLE USART noise")
        self.assertEqual(reply.level, "wrn")
        self.assertEqual(reply.text, "BLE USART noise")
        self.assertFalse(reply.is_error)

    def test_greeting(self):
        reply = c.parse_reply(
            'call :proxy greeting "ver":"0.5.0hw2.1" "mat":"4" "ttpms":"1000" "msg:boot"'
        )
        self.assertEqual(reply.kind, "greeting")
        self.assertEqual(reply.fields["ver"], "0.5.0hw2.1")
        self.assertEqual(reply.fields["mat"], "4")
        self.assertEqual(reply.text, "boot")

    def test_unknown_reply_raises(self):
        with self.assertRaises(c.ProtocolError):
            c.parse_reply("nonsense")

    def test_the_greeting_values_match_the_firmware(self):
        self.assertEqual(c.GREETING["ver"], "0.5.0hw2.1")
        self.assertEqual(c.GREETING["+ack"], "0")


class NumberTest(unittest.TestCase):
    def test_the_firmware_prints_the_sensors_in_hex(self):
        self.assertEqual(c.format_number(500), "1f4")

    def test_letters_are_lowercase(self):
        # a firmware a 'W' + digit eltolással képezi a betűket -> 'a'..'f'
        self.assertEqual(c.format_number(0xDEAD), "dead")

    def test_decimal_radix(self):
        self.assertEqual(c.format_number(500, 10), "500")

    def test_parse_number_uses_the_given_radix(self):
        self.assertEqual(c.parse_number("1f4", 16), 500)
        self.assertEqual(c.parse_number("500", 10), 500)

    def test_parse_number_rejects_garbage(self):
        with self.assertRaises(c.ProtocolError):
            c.parse_number("zz", 16)

    def test_negative_value(self):
        self.assertEqual(c.format_number(-30), "-1e")


class InterfaceRegistryTest(unittest.TestCase):
    def test_all_sixteen_interfaces_are_registered(self):
        self.assertEqual(len(c.INTERFACES), 16)

    def test_the_registry_order_matches_the_firmware(self):
        self.assertEqual(
            [item.name for item in c.INTERFACES],
            [
                "hwiAdc",
                "hwiLed",
                "hwiDrive",
                "drvBattery",
                "hwiSonar",
                "bleCom",
                "hwiBuzz",
                "hwiMic",
                "hwiEnc",
                "hwiLine",
                "hwiPower",
                "hwiLightSense",
                "appLights",
                "appDrive",
                "appSys",
                "appLightSense",
            ],
        )

    def test_battery_voltage_is_hex_and_answers_with_the_set_word(self):
        entry = c.op("drvBattery", "voltage", "get")
        self.assertEqual(entry.radix, 16)
        self.assertEqual(entry.reply_word, "set")

    def test_the_adc_dump_is_decimal(self):
        self.assertEqual(c.op("hwiAdc", "buf", "get").radix, 10)

    def test_the_motor_ops_do_not_reply(self):
        self.assertFalse(c.op("hwiDrive", "dutyA", "set").replies)
        self.assertFalse(c.op("hwiDrive", "dutyB", "set").replies)

    def test_power_off_does_not_reply(self):
        self.assertFalse(c.op("hwiPower", "pwrOff", "call").replies)

    def test_the_stub_interfaces_have_no_ops(self):
        for name in ("hwiSonar", "hwiEnc", "appLights", "appDrive", "appLightSense"):
            self.assertEqual(c.interface(name).ops, ())

    def test_unknown_interface_lookup(self):
        self.assertIsNone(c.interface("hwiNope"))
        self.assertIsNone(c.op("hwiNope", "buf"))

    def test_the_wildcard_op_answers_an_unknown_op(self):
        entry = c.op("hwiMic", "whatever", "get")
        self.assertTrue(entry.wildcard)
        self.assertEqual(entry.unit, "0..2048")

    def test_describe_lists_every_interface(self):
        lines = c.describe()
        self.assertTrue(any(line.startswith("drvBattery") for line in lines))
        self.assertTrue(any("get drvBattery voltage" in line for line in lines))


class ErrorStringTest(unittest.TestCase):
    def test_the_firmware_error_literals(self):
        self.assertEqual(c.ERROR_INVALID_COMMAND, "Invalid command!")
        self.assertEqual(c.ERROR_NO_INTERFACE, "No interface:")
        self.assertEqual(c.ERROR_BUF_OVERFLOW, "BUFOVF!!!!!")

    def test_the_ble_error_strings(self):
        self.assertIn("BLE framing error", c.BLE_ERRORS)
        self.assertIn("BLE USART overrun", c.BLE_ERRORS)


if __name__ == "__main__":
    unittest.main()
