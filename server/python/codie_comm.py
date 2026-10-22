#!/usr/bin/env python3
"""A weboldal Python kommunikációs scriptje — a robot-scriptek futtatója.

A weboldal (a Node.js backend + a böngésző) a robothoz a backend REST API-ján
keresztül szól. Ez a modul a **Python oldali felhang**: a backend elindítja
egy robot-script végrehajtását, ez a modul pedig a `codie` csomag API-ját
használva hajtja végre a lépéseket, és JSON-soros eseményeket streamel vissza.

Használat (a backend hívja):

    python3 codie_comm.py --list
    python3 codie_comm.py --address 00:07:80:66:F0:DA --api http://127.0.0.1:3000 \\
        --script square

Az események (egy sorban, JSON):

    {"event": "start",   "script": "square", "address": "…"}
    {"event": "step",    "index": 0, "action": "forward", "params": {…}}
    {"event": "log",     "message": "a vonal elveszett"}
    {"event": "done",    "steps": 8}
    {"event": "stopped", "reason": "SIGTERM"}
    {"event": "error",   "message": "…", "index": 3}

Kilépési kód: 0 = lefutott, 1 = hiba, 2 = megszakítva.

A scriptek formája: egy ``run(ctx)`` függvény, ami a :class:`Context` példányt
kapja (lásd a `scripts/` mappában). A script **nem** nyithat BLE-kapcsolatot:
a rádiót egyetlen kliens birtokolja, és az a backend.
"""

from __future__ import annotations

import argparse
import importlib.util
import inspect
import json
import os
import signal
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

# A repo gyökere (server/python/codie_comm.py -> server/python -> server -> repo)
REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from codie.api import CodieApi, CodieApiError  # noqa: E402
from codie.robot import Robot  # noqa: E402

__all__ = ["Context", "ScriptError", "ScriptAborted", "ScriptRunner", "list_scripts", "main"]

#: a scriptek alapértelmezett helye
DEFAULT_SCRIPT_DIR = Path(__file__).resolve().parent / "scripts"

#: egy futás maximális hossza (másodperc) — a biztonsági határ
DEFAULT_TIMEOUT_S = 120.0


class ScriptError(RuntimeError):
    """A script hibája (a futás abból áll le, a robotot megállítjuk)."""


class ScriptAborted(ScriptError):
    """A futást megszakították (leállítás gomb, határidő, jel)."""


class _RobotProxy:
    """A robot API körüli héj — minden hívás egy ``step`` eseményt ad.

    A script ugyanazt a :class:`codie.robot.Robot` API-t látja, de a weboldal
    lépésenként látja, mit csinál a robot.
    """

    def __init__(self, robot: Robot, runner: "ScriptRunner") -> None:
        self._robot = robot
        self._runner = runner

    def __getattr__(self, name: str) -> Any:
        target = getattr(self._robot, name)
        if not callable(target):
            return target

        def wrapper(*args: Any, **kwargs: Any) -> Any:
            self._runner.check_deadline()
            params = _describe_call(target, args, kwargs)
            self._runner.step_started(name, params)
            result = target(*args, **kwargs)
            self._runner.step_finished(name)
            return result

        wrapper.__name__ = name
        return wrapper


def _describe_call(func: Callable[..., Any], args: tuple, kwargs: dict) -> dict[str, Any]:
    """A hívás argumentumai JSON-barát alakban (a lépés eseményhez)."""
    try:
        bound = inspect.signature(func).bind(*args, **kwargs)
        bound.apply_defaults()
        return {key: value for key, value in bound.arguments.items()}
    except (TypeError, ValueError):
        return {"args": list(args), **kwargs}


class Context:
    """Amit a robot-script kap.

    Attributes:
        robot: a :class:`codie.robot.Robot` API (a backend API-ján át).
        index: a jelenlegi lépés sorszáma.
    """

    def __init__(self, robot: Robot, runner: "ScriptRunner") -> None:
        self.robot = _RobotProxy(robot, runner)
        self._runner = runner

    @property
    def index(self) -> int:
        """Az eddig végrehajtott lépések száma."""
        return self._runner.index

    # --- a script API ------------------------------------------------------

    def log(self, message: str) -> None:
        """Üzenet a weboldal naplójába."""
        self._runner.emit("log", {"message": str(message)})

    def wait(self, seconds: float) -> None:
        """Várakozás (megszakítható: leállításkor azonnal visszatér)."""
        self._runner.sleep(seconds)

    def stop(self) -> None:
        """A script futásának megszakítása (kivétellel szakítja meg)."""
        raise ScriptAborted("a script megszakította magát")


class ScriptRunner:
    """Egy robot-script végrehajtása, eseményekkel és biztonsági határokkal."""

    def __init__(
        self,
        robot: Robot,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        emit: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> None:
        self.robot = robot
        self.timeout_s = timeout_s
        self._emit = emit or (lambda event, payload: None)
        self._abort = threading.Event()
        self._abort_reason = "leállítás"
        self._deadline = time.monotonic() + timeout_s
        self.index = 0

    # --- események ---------------------------------------------------------

    def emit(self, event: str, payload: dict[str, Any] | None = None) -> None:
        """Egy esemény küldése a hívónak (a backend sorba írja a stdout-ra)."""
        self._emit(event, payload or {})

    def step_started(self, action: str, params: dict[str, Any]) -> None:
        """Egy robot-lépés megkezdődik."""
        self.index += 1
        self.emit("step", {"index": self.index, "action": action, "params": params})

    def step_finished(self, action: str) -> None:
        """Egy robot-lépés befejeződött."""
        self.emit("step-done", {"action": action})

    def abort(self, reason: str = "leállítás") -> None:
        """A futás megszakítása (a fő szálban is felébred)."""
        self._abort_reason = reason
        self._abort.set()

    def sleep(self, seconds: float) -> None:
        """Megszakítható várakozás."""
        if self._abort.wait(timeout=max(0.0, seconds)):
            raise ScriptAborted(self._abort_reason)

    def check_deadline(self) -> None:
        """A futási határ ellenőrzése (a lépések között hívódik)."""
        if time.monotonic() > self._deadline:
            raise ScriptAborted(f"a futás időtartama ({self.timeout_s:g} mp) lejárt")

    # --- a script futtatása -----------------------------------------------

    def run(self, script: Callable[[Context], None], name: str = "script") -> int:
        """Lefuttatja a scriptet.

        Returns:
            0 = lefutott, 2 = megszakítva.
        Raises:
            ScriptError: a script hibája (a hívó 1-es kóddal tér vissza).
        """
        context = Context(self.robot, self)
        self.emit("start", {"script": name})
        try:
            script(context)
        except ScriptAborted as exc:
            self._stop_robot()
            self.emit("stopped", {"reason": str(exc)})
            return 2
        except Exception as exc:  # noqa: BLE001 - a hiba a hívóhoz megy
            self._stop_robot()
            self.emit("error", {"message": f"{type(exc).__name__}: {exc}"})
            raise
        self._stop_robot()
        self.emit("done", {"steps": context.index})
        return 0

    def _stop_robot(self) -> None:
        """A robot megállítása — a futás végén és hiba esetén is."""
        try:
            self.robot.stop()
        except Exception:  # noqa: BLE001 - a leállítás nem dobhat tovább
            pass


# --- a scriptek betöltése -------------------------------------------------


def _script_meta(path: Path) -> dict[str, Any]:
    """Egy script metaadatai (a modul betöltése nélkül)."""
    title = path.stem
    description = ""
    try:
        source = path.read_text(encoding="utf-8")
    except OSError:
        source = ""
    for line in source.splitlines():
        stripped = line.strip()
        if stripped.startswith("# title:"):
            title = stripped[len("# title:") :].strip()
        elif stripped.startswith("# description:"):
            description = stripped[len("# description:") :].strip()
    return {"name": path.stem, "title": title, "description": description}


def list_scripts(script_dir: Path | None = None) -> list[dict[str, Any]]:
    """A scriptek listája (név, cím, leírás).

    Args:
        script_dir: a scriptek mappája (alapértelmezés: a ``scripts/`` a
            modul mellett).
    """
    folder = script_dir or DEFAULT_SCRIPT_DIR
    if not folder.is_dir():
        return []
    return [
        _script_meta(path)
        for path in sorted(folder.glob("*.py"))
        if not path.name.startswith("_")
    ]


def load_script(path: Path) -> Callable[[Context], None]:
    """Betölti a scriptet és visszaadja a ``run`` függvényét.

    Raises:
        ScriptError: ha a script nem importálható vagy nincs ``run`` függvénye.
    """
    spec = importlib.util.spec_from_file_location(f"codie_script_{path.stem}", path)
    if spec is None or spec.loader is None:
        raise ScriptError(f"A script nem tölthető be: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    run = getattr(module, "run", None)
    if not callable(run):
        raise ScriptError(f"A scriptben nincs run(ctx) függvény: {path}")
    return run


# --- a parancssori belépés ------------------------------------------------


def _emit_stdout(event: str, payload: dict[str, Any]) -> None:
    """Egy esemény kiírása a stdout-ra (JSON sor)."""
    sys.stdout.write(json.dumps({"event": event, **payload}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _resolve_script(name: str, script_dir: Path) -> Path | None:
    """A script útvonalának feloldása (név, fájlnév vagy teljes útvonal)."""
    given = Path(name)
    if given.exists():
        return given
    for candidate in (script_dir / given.name, script_dir / f"{given.name}.py"):
        if candidate.exists():
            return candidate
    return None


def firmware_surface() -> dict[str, Any]:
    """A firmware interfész-regiszterének JSON-alakja.

    Ez a robot **valódi** parancsfelülete a visszafejtésből: melyik interfész
    milyen op-ot fogad, milyen argumentummal, milyen egységben válaszol, és
    melyik válasz jön ``set`` szóval (a firmware quirkje).
    """
    from codie import console

    return {
        "version": console.GREETING.get("ver"),
        "commandBufferSize": console.CMD_BUF_SIZE,
        "interfaces": [
            {
                "name": item.name,
                "note": item.note,
                "ops": [
                    {
                        "name": op.name,
                        "verbs": list(op.verbs),
                        "args": op.args,
                        "unit": op.unit,
                        "radix": op.radix,
                        "replies": op.replies,
                        "replyWord": op.reply_word,
                        "wildcard": op.wildcard,
                        "note": op.note,
                    }
                    for op in item.ops
                ],
            }
            for item in console.INTERFACES
        ],
    }


def main(argv: list[str] | None = None) -> int:
    """A belépési pont: scriptek listája vagy egy script futtatása."""
    parser = argparse.ArgumentParser(description="Codie robot-scriptek futtatója")
    parser.add_argument("--list", action="store_true", help="a scriptek listája")
    parser.add_argument(
        "--firmware",
        action="store_true",
        help="a firmware interfész-regiszterének kiírása (JSON)",
    )
    parser.add_argument("--script", help="a futtatandó script neve vagy útvonala")
    parser.add_argument("--address", help="a robot BLE-címe")
    parser.add_argument("--api", default=os.environ.get("CODIE_API_URL"), help="a backend URL-je")
    parser.add_argument("--script-dir", default=str(DEFAULT_SCRIPT_DIR))
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_S)
    args = parser.parse_args(argv)

    script_dir = Path(args.script_dir)
    if args.list:
        print(json.dumps(list_scripts(script_dir), ensure_ascii=False, indent=2))
        return 0

    if args.firmware:
        print(json.dumps(firmware_surface(), ensure_ascii=False, indent=2))
        return 0

    if not args.script:
        parser.error("a --script, --list vagy --firmware kapcsoló kötelező")

    path = _resolve_script(args.script, script_dir)
    if path is None:
        _emit_stdout("error", {"message": f"A script nem található: {args.script}"})
        return 1

    api = CodieApi(base_url=args.api, address=args.address)
    robot = Robot(api, args.address)
    runner = ScriptRunner(robot, timeout_s=args.timeout, emit=_emit_stdout)

    def _handle_signal(signum: int, _frame: Any) -> None:
        runner.abort(signal.Signals(signum).name)

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, _handle_signal)

    try:
        script = load_script(path)
    except Exception as exc:  # noqa: BLE001
        _emit_stdout("error", {"message": f"{type(exc).__name__}: {exc}"})
        return 1

    try:
        return runner.run(script, name=path.stem)
    except (ScriptError, CodieApiError):
        # a runner már kiírta az `error` eseményt
        return 1
    except Exception as exc:  # noqa: BLE001
        _emit_stdout("error", {"message": f"{type(exc).__name__}: {exc}"})
        return 1


if __name__ == "__main__":
    sys.exit(main())
