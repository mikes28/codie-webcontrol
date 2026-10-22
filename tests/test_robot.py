"""Unit tesztek a robot magas szintű API-jára — a transzport fölött.

A `Robot` a parancsszótár egyetlen helyen tartja; a `Stop` viselkedése a
legérzékenyebb: a routing nélküli firmware **nem nyugtázza** a megállítást,
noha a robot megáll — ez nem hiba, csak `acknowledged: False`.

    python -m unittest discover -s tests
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from codie.api import CodieApiError  # noqa: E402
from codie.robot import Robot  # noqa: E402


class RecordingTransport:
    """A parancsokat feljegyző transzport."""

    def __init__(self, results=None, error=None):
        self.calls: list[tuple[str, dict]] = []
        self.results = results or {}
        self.error = error

    def command(self, name, params=None):
        self.calls.append((name, dict(params or {})))
        if self.error is not None:
            raise self.error
        return self.results.get(name, {"action": name})


class RobotTest(unittest.TestCase):
    def setUp(self) -> None:
        self.transport = RecordingTransport(
            {
                "status": {"status": {"batteryPct": 90, "sonarMm": 21}},
                "battery": {"pct": 90},
                "sonar": {"mm": 21},
                "light": {"raw": 4021},
                "line": {"line": {"value": 1, "level": 40.0, "onLine": True}},
                "mic": {"raw": 512},
            }
        )
        self.robot = Robot(self.transport, "00:07:80:66:F0:DA")

    def names(self) -> list[str]:
        return [name for name, _ in self.transport.calls]

    # --- érzékelők ---------------------------------------------------------

    def test_the_sensors_return_their_values(self) -> None:
        self.assertEqual(self.robot.battery(), 90)
        self.assertEqual(self.robot.sonar(), 21)
        self.assertEqual(self.robot.light(), 4021)
        self.assertEqual(self.robot.mic(), 512)
        self.assertTrue(self.robot.line()["onLine"])
        self.assertEqual(self.robot.status()["batteryPct"], 90)

    # --- aktuátorok --------------------------------------------------------

    def test_the_actuators_pass_their_parameters(self) -> None:
        self.robot.beep(250)
        self.robot.led("red")
        self.robot.led_single("blue", 3)
        self.robot.leds_off()
        self.robot.led_anim(1, "green")
        self.assertEqual(
            self.transport.calls,
            [
                ("beep", {"ms": 250}),
                ("led", {"color": "red"}),
                ("ledSingle", {"color": "blue", "index": 3}),
                ("ledsOff", {}),
                ("ledAnim", {"animation": 1, "color": "green", "repeat": 0, "speed": 10}),
            ],
        )

    def test_the_movement_commands_are_finite(self) -> None:
        self.robot.forward(20)
        self.robot.backward(5)
        self.robot.turn(-90)
        self.assertEqual(self.names(), ["forward", "backward", "turn"])
        self.assertEqual(self.transport.calls[0][1], {"cm": 20})
        self.assertEqual(self.transport.calls[2][1], {"degrees": -90})

    # --- a megállítás quirkje ---------------------------------------------

    def test_the_stop_is_accepted_without_an_ack(self) -> None:
        # a firmware nem nyugtázza a MOTOR_BOTH(0,0)-t — a robot mégis megáll
        self.transport.error = CodieApiError(
            504, 'A robot nem nyugtázta a "stop" parancsot — nem jött válasz.'
        )
        result = self.robot.stop()
        self.assertEqual(result["acknowledged"], False)

    def test_the_stop_reports_the_ack_when_there_is_one(self) -> None:
        result = self.robot.stop()
        self.assertEqual(result["acknowledged"], True)

    def test_the_stop_does_not_swallow_other_errors(self) -> None:
        self.transport.error = CodieApiError(409, "A robot nincs csatlakoztatva.")
        with self.assertRaises(CodieApiError):
            self.robot.stop()


if __name__ == "__main__":
    unittest.main()
