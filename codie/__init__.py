"""Codie — BLE vezérlés Raspberry Pi 5-ről.

A csorbazoli/CodieController 2016-os Java PoC-jából visszafejtett wire-protokoll
tiszta Python implementációja, bleak-alapú BLE klienssel.
"""

__version__ = "0.9.0"

from .protocol import (  # noqa: F401
    SERVICE_UUID,
    WRITE_UUID,
    NOTIFY_UUID,
)
from .client import CodieClient  # noqa: F401
