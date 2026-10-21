"""Unit tesztek az MCP toolokra — a `mcp` csomag és a robot nélkül futtatható.

A toolok a `codie.tools` modulon keresztül érhetők el, és a modul-szintű
`api` változó injektálható → a teszt a hálózatot nem is látja.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from codie import tools  # noqa: E402
from codie.api import CodieApiError  # noqa: E402


class FakeApi:
    """A CodieApi hamis másolata: rögzíti a hívásokat és fix válaszokat ad."""

    def __init__(self, error: CodieApiError | None = None, sonar_value: int = 21) -> None:
        self.calls: list[tuple] = []
        self.error = error
        self.sonar_value = sonar_value

    def _record(self, name: str, *args):
        self.calls.append((name, *args))
        if self.error is not None:
            raise self.error
        return {}

    def status(self):
        self._record("status")
        return {
            "batteryPct": 97,
            "sonarMm": 21,
            "lightRaw": 4021,
            "line": {"value": 15663357, "level": 14.94, "onLine": False},
        }

    def sonar(self):
        self._record("sonar")
        return self.sonar_value

    def forward(self, cm):
        return self._record("forward", cm)

    def backward(self, cm):
        return self._record("backward", cm)

    def turn(self, degrees):
        return self._record("turn", degrees)

    def stop(self):
        return self._record("stop")

    def beep(self, ms):
        return self._record("beep", ms)

    def morse(self, text):
        return self._record("morse", text)

    def led(self, color):
        return self._record("led", color)

    def command(self, name, params=None, address=None):
        return self._record("command", name, params, address)


class ToolTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.api = FakeApi()
        tools.set_api(self.api)
        self.addCleanup(tools.set_api, None)

    # --- érzékelés ---------------------------------------------------------

    async def test_status_returns_the_robot_state(self) -> None:
        status = await tools.tool_status()
        self.assertEqual(status["batteryPct"], 97)
        self.assertEqual(status["sonarMm"], 21)
        self.assertEqual(self.api.calls, [("status",)])

    async def test_look_ahead_returns_the_sonar_distance(self) -> None:
        self.assertEqual(await tools.tool_look_ahead(), 21)
        self.assertEqual(self.api.calls, [("sonar",)])

    async def test_look_ahead_returns_none_when_the_sensor_does_not_answer(self) -> None:
        # 504 = a robot csatlakozott, de a szonár nem válaszolt → nem mérhető
        self.api.error = CodieApiError(504, "A robot nem válaszolt.")
        self.assertIsNone(await tools.tool_look_ahead())

    async def test_look_ahead_propagates_the_other_errors(self) -> None:
        self.api.error = CodieApiError(409, "A robot nincs csatlakoztatva.")
        with self.assertRaises(CodieApiError):
            await tools.tool_look_ahead()

    # --- mozgás ------------------------------------------------------------

    async def test_drive_forward_is_finite_and_reports_the_distance(self) -> None:
        self.assertEqual(await tools.tool_drive_forward(10), "előre 10 cm")
        self.assertEqual(self.api.calls, [("forward", 10)])

    async def test_drive_backward(self) -> None:
        self.assertEqual(await tools.tool_drive_backward(25), "hátra 25 cm")
        self.assertEqual(self.api.calls, [("backward", 25)])

    async def test_turn_passes_the_degrees_through(self) -> None:
        # a pozitív fok = jobbra konvenciót a backend fordítja speed előjellé
        self.assertEqual(await tools.tool_turn(90), "fordult 90°")
        self.assertEqual(await tools.tool_turn(-90), "fordult -90°")
        self.assertEqual(self.api.calls, [("turn", 90), ("turn", -90)])

    async def test_stop(self) -> None:
        self.assertEqual(await tools.tool_stop(), "megállt")
        self.assertEqual(self.api.calls, [("stop",)])

    # --- kimenet -----------------------------------------------------------

    async def test_beep(self) -> None:
        self.assertEqual(await tools.tool_beep(500), "beep 500 ms")
        self.assertEqual(self.api.calls, [("beep", 500)])

    async def test_say_morse(self) -> None:
        self.assertEqual(await tools.tool_say_morse("SOS"), "morse: SOS")
        self.assertEqual(self.api.calls, [("morse", "SOS")])

    async def test_set_leds_without_index_sets_every_led(self) -> None:
        self.assertEqual(await tools.tool_set_leds("red"), "LED-ek: red")
        self.assertEqual(self.api.calls, [("led", "red")])

    async def test_set_leds_with_index_uses_the_single_led_command(self) -> None:
        self.assertEqual(await tools.tool_set_leds("blue", 3), "LED 3: blue")
        self.assertEqual(
            self.api.calls, [("command", "ledSingle", {"color": "blue", "index": 3}, None)]
        )

    async def test_set_leds_lowercases_the_color(self) -> None:
        await tools.tool_set_leds("RED")
        self.assertEqual(self.api.calls, [("led", "red")])

    # --- hibák -------------------------------------------------------------

    async def test_the_tools_propagate_the_api_error(self) -> None:
        self.api.error = CodieApiError(409, "A robot nincs csatlakoztatva.")
        with self.assertRaises(CodieApiError) as ctx:
            await tools.tool_drive_forward(10)
        self.assertEqual(ctx.exception.status, 409)


if __name__ == "__main__":
    unittest.main()
