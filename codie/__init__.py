"""Codie — BLE vezérlés Raspberry Pi 5-ről.

A BLE réteg a **Node.js backendben** van (`server/`, BlueZ + noble): az a két
Codie-generációt beszél, kezeli az újracsatlakozást és a telemetriát. Ez a csomag
két dolgot ad:

- a **protokoll-referencia** (`codie.protocol`, `codie.morse`, `codie.tunes`) — a JS
  port bájtra bájtra ezt követi, és a `server/test/parity.test.js` ellenőrzi;
- a **REST kliens** (`codie.api`) — a backend HTTP felületére épülő, standard
  library alapú kapu (az MCP/agent réteg ezt használja).

A Python oldalon nincs BLE réteg: a `bleak` kliens a routing generációt szólná,
amit a projektben nincs hardver.
"""

__version__ = "0.5.0"

from .api import CodieApi, CodieApiError  # noqa: F401
from .protocol import (  # noqa: F401
    SERVICE_UUID,
    WRITE_UUID,
    NOTIFY_UUID,
)
