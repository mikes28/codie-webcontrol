"""Unit tesztek a CodieClient connect-retry logikájára — robot nélkül."""

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from codie.client import CodieClient  # noqa: E402


class ConnectRetryTest(unittest.TestCase):
    def test_retries_then_succeeds_and_scans_between(self):
        c = CodieClient("AA:BB:CC:DD:EE:FF", adapter=None, connect_retries=3, retry_delay=0)
        state = {"connect": 0, "scan": 0}

        async def flaky_connect():
            state["connect"] += 1
            if state["connect"] < 2:      # az első próba "elalvás" -> hiba
                raise TimeoutError("asleep")

        async def fake_scan():
            state["scan"] += 1

        c._connect_once = flaky_connect
        c._scan_wake = fake_scan
        asyncio.run(c.connect())

        self.assertEqual(state["connect"], 2)   # másodjára sikerült
        self.assertEqual(state["scan"], 1)      # egyszer ébresztett közben

    def test_gives_up_after_all_retries(self):
        c = CodieClient("AA:BB:CC:DD:EE:FF", connect_retries=2, retry_delay=0)
        state = {"scan": 0}

        async def always_fail():
            raise TimeoutError("asleep")

        async def fake_scan():
            state["scan"] += 1

        c._connect_once = always_fail
        c._scan_wake = fake_scan
        with self.assertRaises(TimeoutError):
            asyncio.run(c.connect())
        self.assertEqual(state["scan"], 1)      # 2 próba között 1 scan

    def test_single_try_no_scan(self):
        c = CodieClient("AA:BB:CC:DD:EE:FF", connect_retries=1, retry_delay=0)
        state = {"connect": 0, "scan": 0}

        async def ok_connect():
            state["connect"] += 1

        async def fake_scan():
            state["scan"] += 1

        c._connect_once = ok_connect
        c._scan_wake = fake_scan
        asyncio.run(c.connect())
        self.assertEqual((state["connect"], state["scan"]), (1, 0))


if __name__ == "__main__":
    unittest.main()
