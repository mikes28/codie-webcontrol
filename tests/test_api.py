"""Unit tesztek a Codie REST kliensre — robot és hálózat nélkül futtatható.

A backend minimális másolatát egy `http.server` szolgálja ki külön threadben, így
a teszt a valódi kérés/válasz formátumot ellenőrzi (a cím URL-kódolva megy ki,
a hiba a backend `{ "error": ... }` alakjában jön).
"""

import json
import os
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from codie.api import CodieApi, CodieApiError  # noqa: E402

ROBOT_ADDRESS = "00:07:80:66:F0:DA"

ROBOT = {
    "address": ROBOT_ADDRESS,
    "name": "Codie",
    "connected": True,
    "variant": "no-routing",
    "telemetry": {
        "batteryPct": 97,
        "sonarMm": 21,
        "lightRaw": 4021,
        "line": {"value": 15663357, "level": 14.94, "onLine": False},
    },
}

# a backend parancs-válaszai (a valódi alak: { address, action, ... })
COMMAND_RESULTS = {
    "status": {
        "status": {
            "batteryPct": 97,
            "sonarMm": 21,
            "lightRaw": 4021,
            "line": {"value": 15663357, "level": 14.94, "onLine": False},
        }
    },
    "battery": {"pct": 97},
    "sonar": {"mm": 21},
    "light": {"raw": 4021},
    "line": {"line": {"value": 15663357, "level": 14.94, "onLine": False}},
    "mic": {"raw": 512},
    "beep": {"ms": 500},
    "morse": {"text": "SOS"},
    "led": {"color": "red"},
    "forward": {"cm": 10},
}


class FakeBackend(BaseHTTPRequestHandler):
    """A Codie backend minimális másolata."""

    #: a rögzített kérések — (path, body)
    calls: list = []
    #: ha nem None, minden kérés ezt a hibát adja: (status, message)
    fail_with = None
    #: a robot csatlakoztatva van-e
    connected = True

    def log_message(self, *args):  # a teszt kimenete csendes maradjon
        pass

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = unquote(self.path)
        if self.fail_with is not None:
            status, message = self.fail_with
            return self._send(status, {"error": message})
        if path == "/api/health":
            return self._send(200, {"ok": True, "robots": 1})
        if path == "/api/robots":
            robot = {**ROBOT, "connected": self.connected}
            return self._send(200, {"robots": [robot]})
        if path == f"/api/robots/{ROBOT_ADDRESS}":
            return self._send(200, {**ROBOT, "connected": self.connected})
        if path == f"/api/robots/{ROBOT_ADDRESS}/telemetry":
            return self._send(200, {"address": ROBOT_ADDRESS, "telemetry": ROBOT["telemetry"]})
        return self._send(404, {"error": "Ismeretlen robot cím."})

    def do_POST(self) -> None:
        path = unquote(self.path)
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        body = json.loads(raw or b"{}")
        FakeBackend.calls.append({"path": path, "body": body})
        if self.fail_with is not None:
            status, message = self.fail_with
            return self._send(status, {"error": message})
        if path.endswith("/connect"):
            return self._send(200, {**ROBOT, "connected": True})
        if path.endswith("/disconnect"):
            return self._send(200, {**ROBOT, "connected": False})
        if path.endswith("/command"):
            name = body.get("name")
            result = dict(COMMAND_RESULTS.get(name, {}))
            if name == "beep":  # a backend a kért időtartamot echoesolja vissza
                result["ms"] = body.get("params", {}).get("ms")
            return self._send(200, {"address": ROBOT_ADDRESS, "action": name, **result})
        return self._send(404, {"error": "Ismeretlen robot cím."})


class CodieApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeBackend)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)

    def setUp(self) -> None:
        FakeBackend.calls.clear()
        FakeBackend.fail_with = None
        FakeBackend.connected = True
        self.api = CodieApi(base_url=self.base_url, address=ROBOT_ADDRESS)

    # --- alapműveletek -----------------------------------------------------

    def test_health(self) -> None:
        self.assertEqual(self.api.health(), {"ok": True, "robots": 1})

    def test_robots_returns_the_list_not_the_wrapper(self) -> None:
        robots = self.api.robots()
        self.assertIsInstance(robots, list)
        self.assertEqual(len(robots), 1)
        self.assertEqual(robots[0]["address"], ROBOT_ADDRESS)

    def test_robot(self) -> None:
        self.assertEqual(self.api.robot(ROBOT_ADDRESS)["name"], "Codie")

    def test_connect_and_disconnect(self) -> None:
        self.assertTrue(self.api.connect(ROBOT_ADDRESS)["connected"])
        self.assertFalse(self.api.disconnect(ROBOT_ADDRESS)["connected"])

    # --- parancsok ---------------------------------------------------------

    def test_command_sends_name_and_params(self) -> None:
        result = self.api.command("beep", {"ms": 300})
        self.assertEqual(result["action"], "beep")
        self.assertEqual(result["ms"], 300)
        self.assertEqual(len(FakeBackend.calls), 1)
        call = FakeBackend.calls[0]
        self.assertEqual(call["path"], f"/api/robots/{ROBOT_ADDRESS}/command")
        self.assertEqual(call["body"], {"name": "beep", "params": {"ms": 300}})

    def test_command_without_params_sends_the_name_only(self) -> None:
        self.api.command("stop")
        self.assertEqual(FakeBackend.calls[0]["body"], {"name": "stop"})

    def test_command_uses_the_given_address(self) -> None:
        self.api.command("beep", {"ms": 100}, address="00:07:80:66:F0:DB")
        self.assertEqual(
            FakeBackend.calls[0]["path"], "/api/robots/00:07:80:66:F0:DB/command"
        )

    # --- érzékelők ---------------------------------------------------------

    def test_status_returns_the_status_field(self) -> None:
        status = self.api.status()
        self.assertEqual(status["batteryPct"], 97)
        self.assertEqual(status["sonarMm"], 21)
        self.assertEqual(status["lightRaw"], 4021)
        self.assertEqual(status["line"]["level"], 14.94)

    def test_sensor_helpers_extract_the_right_fields(self) -> None:
        self.assertEqual(self.api.battery(), 97)
        self.assertEqual(self.api.sonar(), 21)
        self.assertEqual(self.api.light(), 4021)
        self.assertEqual(self.api.mic(), 512)
        self.assertEqual(self.api.line()["value"], 15663357)

    def test_led_anim_sends_the_animation_and_the_color(self) -> None:
        self.api.led_anim(1, "blue")
        self.assertEqual(
            FakeBackend.calls[0]["body"],
            {"name": "ledAnim", "params": {"animation": 1, "color": "blue"}},
        )

    # --- a cím kiválasztása -----------------------------------------------

    def test_resolve_address_picks_the_connected_robot(self) -> None:
        self.assertEqual(self.api.resolve_address(), ROBOT_ADDRESS)

    def test_resolve_address_without_a_connected_robot_raises(self) -> None:
        FakeBackend.connected = False
        with self.assertRaises(CodieApiError) as ctx:
            self.api.resolve_address()
        self.assertEqual(ctx.exception.status, 409)

    # --- hibakezelés -------------------------------------------------------

    def test_http_error_becomes_a_codie_api_error(self) -> None:
        FakeBackend.fail_with = (409, "A robot nincs csatlakoztatva.")
        with self.assertRaises(CodieApiError) as ctx:
            self.api.command("beep", {"ms": 100})
        self.assertEqual(ctx.exception.status, 409)
        self.assertEqual(ctx.exception.message, "A robot nincs csatlakoztatva.")
        self.assertIn("nincs csatlakoztatva", str(ctx.exception))

    def test_gateway_timeout_is_reported_as_504(self) -> None:
        FakeBackend.fail_with = (504, "A robot nem nyugtázta a parancsot.")
        with self.assertRaises(CodieApiError) as ctx:
            self.api.command("beep", {"ms": 100})
        self.assertEqual(ctx.exception.status, 504)

    def test_unreachable_backend_raises_with_status_zero(self) -> None:
        api = CodieApi(base_url="http://127.0.0.1:1", address=ROBOT_ADDRESS)
        with self.assertRaises(CodieApiError) as ctx:
            api.health()
        self.assertEqual(ctx.exception.status, 0)

    # --- a környezeti változók szerepe -------------------------------------

    def test_the_explicit_base_url_wins_over_the_environment(self) -> None:
        # a CODIE_API_URL nem írhatja felül a hívó szándékát (pl. a teszt mockja)
        os.environ["CODIE_API_URL"] = "http://127.0.0.1:9"
        try:
            api = CodieApi(base_url=self.base_url, address=ROBOT_ADDRESS)
            self.assertEqual(api.base_url, self.base_url)
            self.assertEqual(api.health(), {"ok": True, "robots": 1})
        finally:
            del os.environ["CODIE_API_URL"]

    def test_the_environment_is_the_fallback(self) -> None:
        os.environ["CODIE_API_URL"] = self.base_url
        os.environ["CODIE_ADDRESS"] = ROBOT_ADDRESS
        try:
            api = CodieApi()
            self.assertEqual(api.base_url, self.base_url)
            self.assertEqual(api.address, ROBOT_ADDRESS)
        finally:
            del os.environ["CODIE_API_URL"]
            del os.environ["CODIE_ADDRESS"]


if __name__ == "__main__":
    unittest.main()
