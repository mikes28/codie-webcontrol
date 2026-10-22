"""Unit tesztek a weboldal Python script-futtatójára.

A futtató (``server/python/codie_comm.py``) a robothoz a backend REST API-ján
keresztül szól — itt egy stub transzporttal teszteljük, hogy a lépések,
az események és a biztonsági viselkedés (a robot megállítása) a helyes.

    python -m unittest discover -s tests
"""

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "server" / "python"))

import codie_comm as engine  # noqa: E402
from codie.robot import Robot  # noqa: E402


class StubTransport:
    """A backend helyett álló, hívásokat gyűjtő transzport."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def command(self, name, params=None):
        self.calls.append((name, dict(params or {})))
        if name == "sonar":
            return {"mm": 500}
        if name == "line":
            return {"line": {"value": 1, "level": 40.0, "onLine": True}}
        if name == "status":
            return {"status": {"batteryPct": 90}}
        return {"action": name}

    def names(self) -> list[str]:
        return [name for name, _ in self.calls]


class ScriptEngineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.transport = StubTransport()
        self.robot = Robot(self.transport)
        self.events: list[tuple[str, dict]] = []
        self.runner = engine.ScriptRunner(
            self.robot, timeout_s=5, emit=lambda event, payload: self.events.append((event, payload))
        )

    def event_names(self) -> list[str]:
        return [event for event, _ in self.events]

    # --- egy egyszerű script futtatása ------------------------------------

    def test_the_script_runs_and_its_commands_reach_the_transport(self) -> None:
        def script(ctx):
            ctx.robot.forward(10)
            ctx.robot.turn(90)

        self.assertEqual(self.runner.run(script, name="demo"), 0)
        self.assertEqual(self.transport.names(), ["forward", "turn", "stop"])

    def test_the_parameters_are_passed_through(self) -> None:
        def script(ctx):
            ctx.robot.forward(12.5)

        self.runner.run(script)
        self.assertIn(("forward", {"cm": 12.5}), self.transport.calls)

    def test_the_events_describe_the_run(self) -> None:
        def script(ctx):
            ctx.log("indulok")
            ctx.robot.forward(5)

        self.runner.run(script, name="demo")
        names = self.event_names()
        self.assertEqual(names[0], "start")
        self.assertIn("log", names)
        self.assertIn("step", names)
        self.assertEqual(names[-1], "done")

    def test_the_robot_is_stopped_at_the_end(self) -> None:
        def script(ctx):
            ctx.robot.forward(5)

        self.runner.run(script)
        self.assertEqual(self.transport.names()[-1], "stop")

    def test_the_start_event_names_the_script(self) -> None:
        def script(ctx):
            pass

        self.runner.run(script, name="demo")
        payload = dict(self.events)["start"]
        self.assertEqual(payload["script"], "demo")

    # --- hibák és megszakítás ---------------------------------------------

    def test_a_failing_script_stops_the_robot_and_reports_the_error(self) -> None:
        def script(ctx):
            ctx.robot.forward(5)
            raise ValueError("bomba")

        with self.assertRaises(ValueError):
            self.runner.run(script)
        self.assertEqual(self.transport.names()[-1], "stop")
        errors = [payload for event, payload in self.events if event == "error"]
        self.assertEqual(len(errors), 1)
        self.assertIn("bomba", errors[0]["message"])

    def test_an_aborted_run_reports_stopped(self) -> None:
        def script(ctx):
            ctx.stop()

        self.assertEqual(self.runner.run(script), 2)
        self.assertIn("stopped", self.event_names())

    def test_the_abort_interrupts_a_wait(self) -> None:
        def script(ctx):
            self.runner.abort("teszt")
            ctx.wait(5)

        self.assertEqual(self.runner.run(script), 2)

    def test_the_timeout_stops_the_run(self) -> None:
        runner = engine.ScriptRunner(self.robot, timeout_s=0, emit=lambda *_: None)

        def script(ctx):
            ctx.robot.forward(5)

        self.assertEqual(runner.run(script), 2)

    # --- a scriptek betöltése ----------------------------------------------

    def test_the_shipped_scripts_are_loadable(self) -> None:
        scripts = engine.list_scripts()
        self.assertTrue(scripts)
        names = {item["name"] for item in scripts}
        self.assertIn("square", names)
        for item in scripts:
            self.assertTrue(item["title"])
            path = engine.DEFAULT_SCRIPT_DIR / f"{item['name']}.py"
            run = engine.load_script(path)
            self.assertTrue(callable(run))

    def test_a_script_without_a_run_function_is_rejected(self) -> None:
        path = engine.DEFAULT_SCRIPT_DIR / "_nincs_run.py"
        path.write_text("# title: teszt\nx = 1\n", encoding="utf-8")
        try:
            with self.assertRaises(engine.ScriptError):
                engine.load_script(path)
        finally:
            path.unlink()

    def test_the_private_scripts_are_not_listed(self) -> None:
        path = engine.DEFAULT_SCRIPT_DIR / "_rejtett.py"
        path.write_text("def run(ctx):\n    pass\n", encoding="utf-8")
        try:
            names = {item["name"] for item in engine.list_scripts()}
            self.assertNotIn("_rejtett", names)
        finally:
            path.unlink()


if __name__ == "__main__":
    unittest.main()
