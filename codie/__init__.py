"""Codie — BLE vezérlés Raspberry Pi 5-ről.

A BLE réteg a **Node.js backendben** van (`server/`, BlueZ + noble): az a két
Codie-generációt beszél, kezeli az újracsatlakozást és a telemetriát. Ez a csomag
a fölötte lévő Python réteg:

- :mod:`codie.console` — a **visszafejtett firmware** parancsnyelve
  (``get|set|call <interface> <op>``) és az interfész-regiszter: mit tud a
  robot, milyen egységben válaszol;
- :mod:`codie.wire` / :mod:`codie.wire_norrouting` — a két generáció BLE
  frame-formátuma (a JS port bájtra bájtra ezt követi, a
  ``server/test/parity.test.js`` ellenőrzi);
- :mod:`codie.robot` — a robot magas szintű API-ja bármilyen transzport fölött;
- :mod:`codie.api` — a REST transzport (a backend HTTP felületére épülő,
  standard library alapú kapu — ezt használja az MCP/agent réteg és a
  weboldal Python scriptek);
- :mod:`codie.morse` / :mod:`codie.tunes` — a hang ritmusának kódolása.

A Python oldalon nincs BLE réteg: a rádiót egyetlen kliens birtokolja, és
az a backend.
"""

__version__ = "0.7.0"

from .api import CodieApi, CodieApiError  # noqa: F401
from .robot import COMMAND_NAMES, Robot, RobotError, Transport  # noqa: F401
from .wire import SERVICE_UUID, WRITE_UUID, NOTIFY_UUID  # noqa: F401
