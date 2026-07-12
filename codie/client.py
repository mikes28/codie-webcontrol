"""CodieClient — aszinkron BLE kliens (bleak) a Codie robothoz.

A kliens csatlakozik, feliratkozik a notify-csatornára, és a kérés SEQ ->
válasz REQSEQ párosítással kéri le a szenzorértékeket. Az aktuátor-parancsok
(beep, LED, mozgás) is várnak nyugtára, de ha nem jön, `None`-t adnak vissza.
"""

from __future__ import annotations

import asyncio

from bleak import BleakClient, BleakScanner

from . import morse, protocol as p
from . import tunes


class CodieClient:
    def __init__(
        self,
        address: str,
        adapter: str = "hci0",
        timeout: float = 15.0,
        connect_retries: int = 3,
        retry_delay: float = 3.0,
    ):
        self.address = address
        self.adapter = adapter
        self._connect_timeout = timeout
        self._connect_retries = max(1, connect_retries)
        self._retry_delay = retry_delay
        self._client: BleakClient | None = None
        self._pending: dict[int, asyncio.Future] = {}
        self.notifications: list[tuple[bytes, dict | None]] = []

    # --- életciklus ------------------------------------------------------

    async def __aenter__(self) -> "CodieClient":
        await self.connect()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.disconnect()

    async def connect(self) -> None:
        """Csatlakozás retry-jal + felébresztő scannel.

        A Codie egy idő után elalszik; ilyenkor az első connect timeoutol. Egy BLE-scan
        felébreszti / újrafelfedezteti a BlueZ-vel, majd újrapróbáljuk — így egy elalvás nem
        bukik el tévedésből (fontos éles Hermes-használatnál).
        """
        last_exc: Exception | None = None
        for attempt in range(1, self._connect_retries + 1):
            try:
                await self._connect_once()
                return
            except Exception as exc:  # noqa: BLE001 - TimeoutError / BleakError stb.
                last_exc = exc
                await self._cleanup_partial()
                if attempt < self._connect_retries:
                    await self._scan_wake()
                    await asyncio.sleep(self._retry_delay)
        assert last_exc is not None
        raise last_exc

    async def _connect_once(self) -> None:
        kwargs = {"timeout": self._connect_timeout}
        if self.adapter:
            kwargs["adapter"] = self.adapter
        client = BleakClient(self.address, **kwargs)
        await client.connect()
        await client.start_notify(p.NOTIFY_UUID, self._on_notify)
        self._client = client

    async def _scan_wake(self) -> None:
        """Best-effort felébresztő/discovery scan a sikertelen connect után."""
        try:
            kwargs = {"timeout": 6.0}
            if self.adapter:
                kwargs["adapter"] = self.adapter
            await BleakScanner.discover(**kwargs)
        except Exception:  # noqa: BLE001 - a scan best-effort, a lényeg a retry
            pass

    async def _cleanup_partial(self) -> None:
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:  # noqa: BLE001
                pass
            self._client = None

    async def disconnect(self) -> None:
        if self._client is not None:
            try:
                await self._client.disconnect()
            finally:
                self._client = None

    @property
    def is_connected(self) -> bool:
        return self._client is not None and self._client.is_connected

    # --- notify kezelés --------------------------------------------------

    def _on_notify(self, _characteristic, data: bytearray) -> None:
        raw = bytes(data)
        resp = p.decode_response(raw)
        self.notifications.append((raw, resp))
        if resp is not None:
            fut = self._pending.get(resp["req_seq"])
            if fut is not None and not fut.done():
                fut.set_result(resp)

    # --- alap küldés/válasz ---------------------------------------------

    async def _send(
        self,
        cmd_id: int,
        args: bytes = b"",
        expect_response: bool = True,
        timeout: float = 2.5,
    ) -> dict | None:
        if self._client is None:
            raise RuntimeError("Nincs kapcsolat — hívd előbb a connect()-et.")
        frame, seq = p.build_frame(cmd_id, args)
        loop = asyncio.get_event_loop()
        fut: asyncio.Future = loop.create_future()
        if expect_response:
            self._pending[seq] = fut
        await self._client.write_gatt_char(p.WRITE_UUID, frame, response=False)
        if not expect_response:
            return None
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            return None
        finally:
            self._pending.pop(seq, None)

    # --- aktuátorok ------------------------------------------------------

    async def beep(self, duration_ms: int = 1000) -> dict | None:
        return await self._send(p.CMD_SPEAK_BEEP, p.beep_args(duration_ms))

    async def play_rhythm(self, pattern: list[tuple[int, int]]) -> None:
        """Ritmusminta lejátszása: [(csipogás_ms, szünet_ms), ...].

        Fire-and-forget beepek, a ritmust lokális várakozás adja (a beepre nem
        várunk nyugtát, hogy pontos legyen az időzítés).
        """
        for beep_ms, gap_ms in pattern:
            await self._send(p.CMD_SPEAK_BEEP, p.beep_args(int(beep_ms)), expect_response=False)
            await asyncio.sleep((beep_ms + gap_ms) / 1000.0)

    async def play_morse(self, text: str, unit_ms: int = 120) -> None:
        await self.play_rhythm(morse.text_to_rhythm(text, unit_ms))

    async def play_tune(self, name: str) -> None:
        try:
            pattern = tunes.RHYTHMS[name]
        except KeyError as exc:
            raise ValueError(f"Ismeretlen ritmus: {name!r}. Elérhető: {', '.join(tunes.names())}") from exc
        await self.play_rhythm(pattern)

    async def led_all(self, color: str = "green") -> dict | None:
        return await self._send(p.CMD_LED_SET_COLOR, p.led_all_args(color))

    async def led_single(self, color: str, index: int) -> dict | None:
        return await self._send(p.CMD_LED_SET_COLOR, p.led_single_args(color, index))

    async def leds_off(self) -> dict | None:
        # "kikapcsolt" = value 0 (fekete)
        h, s, _v = p.color_hsv("white")
        return await self._send(p.CMD_LED_SET_COLOR, p._u16(0x0FFF) + p._u8(0) + p._u8(0) + p._u8(0))

    async def drive_speed(self, left: int, right: int) -> dict | None:
        return await self._send(p.CMD_DRIVE_SPEED, p.drive_speed_args(left, right))

    async def stop(self) -> dict | None:
        return await self.drive_speed(0, 0)

    async def drive_distance(self, distance_mm: int, left: int = 30, right: int = 30) -> dict | None:
        return await self._send(p.CMD_DRIVE_DISTANCE, p.drive_distance_args(distance_mm, left, right))

    async def drive_turn(self, degree: int, speed: int = 30) -> dict | None:
        return await self._send(p.CMD_DRIVE_TURN, p.drive_turn_args(degree, speed))

    # --- szenzorok -------------------------------------------------------

    async def battery(self) -> int | None:
        r = await self._send(p.CMD_BATTERY)
        return p.read_u8(r["args"], 0) if r else None

    async def light(self) -> int | None:
        r = await self._send(p.CMD_LIGHT)
        return p.read_u16(r["args"], 0) if r else None

    async def line(self) -> tuple[int | None, int | None] | None:
        r = await self._send(p.CMD_LINE)
        if not r:
            return None
        return p.read_u16(r["args"], 0), p.read_u16(r["args"], 2)

    async def sonar(self) -> int | None:
        r = await self._send(p.CMD_SONAR)
        return p.read_u16(r["args"], 0) if r else None

    async def mic(self) -> int | None:
        r = await self._send(p.CMD_MIC)
        return p.read_u16(r["args"], 0) if r else None

    async def battery_voltage(self) -> int | None:
        r = await self._send(p.CMD_BATTERY_VOLTAGE)
        return p.read_u16(r["args"], 0) if r else None

    # --- protokoll-jelzések (hivatalos SDK) ------------------------------

    async def app_connected(self) -> dict | None:
        """Jelzi az MCU-nak, hogy egy app csatlakozott (a hivatalos app is ezt küldi)."""
        return await self._send(p.CMD_APP_CONNECTED)

    async def app_disconnected(self) -> dict | None:
        return await self._send(p.CMD_APP_DISCONNECTED)
