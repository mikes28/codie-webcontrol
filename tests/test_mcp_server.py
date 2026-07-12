"""Smoke-tesztek az MCP szerverre — robot nélkül (fake klienssel).

Ha az `mcp` csomag nincs telepítve, a teszt kimarad.
"""

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

try:
    from codie import mcp_server
    HAVE_MCP = True
except Exception:  # noqa: BLE001
    HAVE_MCP = False


class FakeCodie:
    def __init__(self):
        self.calls: list[tuple] = []

    @property
    def is_connected(self):
        return True

    async def drive_turn(self, degree, speed):
        self.calls.append(("turn", degree, speed))

    async def drive_distance(self, mm, left, right):
        self.calls.append(("distance", mm, left, right))

    async def drive_speed(self, left, right):
        self.calls.append(("speed", left, right))


@unittest.skipUnless(HAVE_MCP, "mcp csomag nincs telepítve")
class McpServerTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeCodie()

        async def fake_ensure():
            return self.fake

        self._orig = mcp_server._ensure
        mcp_server._ensure = fake_ensure

    def tearDown(self):
        mcp_server._ensure = self._orig

    def test_nine_tools_registered(self):
        tools = asyncio.run(mcp_server.mcp.list_tools())
        names = {t.name for t in tools}
        self.assertEqual(len(tools), 9)
        self.assertLessEqual(
            {"status", "look_ahead", "drive_forward", "drive_backward",
             "turn", "stop", "beep", "say_morse", "set_leds"},
            names,
        )

    def test_turn_never_sends_negative_degree(self):
        # A javítás lényege: a fok mindig nem-negatív u16, az irány a speed előjeléből jön.
        asyncio.run(mcp_server.turn(-90))
        kind, degree, speed = self.fake.calls[-1]
        self.assertEqual(kind, "turn")
        self.assertEqual(degree, 90)      # abszolútérték, NINCS u16 wraparound (65446)
        self.assertGreater(speed, 0)      # negatív fok = balra = pozitív speed (API)

    def test_turn_right_uses_negative_speed(self):
        asyncio.run(mcp_server.turn(90))
        _, degree, speed = self.fake.calls[-1]
        self.assertEqual(degree, 90)
        self.assertLess(speed, 0)         # pozitív fok = jobbra = negatív speed

    def test_drive_backward_uses_negative_speeds(self):
        asyncio.run(mcp_server.drive_backward(50))
        kind, mm, left, right = self.fake.calls[-1]
        self.assertEqual((kind, mm), ("distance", 500))
        self.assertLess(left, 0)
        self.assertLess(right, 0)

    def test_drive_forward_clamped(self):
        asyncio.run(mcp_server.drive_forward(999))
        _, mm, left, right = self.fake.calls[-1]
        self.assertEqual(mm, 2000)        # 200 cm plafon
        self.assertGreater(left, 0)


if __name__ == "__main__":
    unittest.main()
