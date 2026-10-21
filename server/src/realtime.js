/**
 * socket.io réteg — a szerver és a (későbbi) frontend közötti valós idejű csatorna.
 *
 * A szerver a registry eseményeit továbbítja ('scan', 'robot', 'telemetry'),
 * a kliens pedig ugyanazokat a műveleteket kérheti, mint a REST API
 * ('scan:request', 'robot:connect', 'robot:disconnect', 'robot:command').
 */

'use strict';

import { resolveScanDuration } from './ble/registry.js';

export function attachRealtime({ io, registry }) {
  io.on('connection', (socket) => {
    socket.emit('robots', { robots: registry.list() });

    socket.on('scan:request', async (payload = {}) => {
      try {
        // a scan eredményét a registry broadcastolja ('scan' esemény) — nem küldjük
        // külön is, hogy a kérést kapó socket ne kapja meg kétszer
        await registry.scan({ durationMs: resolveScanDuration(payload.durationMs, registry.filters.scanMs) });
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    socket.on('robot:connect', async (payload = {}) => {
      try {
        const robot = await registry.connect(payload.address);
        socket.emit('robot', robot);
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    socket.on('robot:disconnect', async (payload = {}) => {
      try {
        const robot = await registry.disconnect(payload.address);
        socket.emit('robot', robot);
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    socket.on('robot:command', async (payload = {}) => {
      try {
        // az eredményt a registry broadcastolja ('command' -> 'command-result')
        await registry.command(payload.address, payload.name, payload.params ?? {});
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    // a mikrofon figyelésének indítása/leállítása (a felület szintmérője)
    socket.on('mic:start', (payload = {}) => {
      try {
        registry.startMicStream(payload.address);
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });

    socket.on('mic:stop', (payload = {}) => {
      try {
        registry.stopMicStream(payload.address);
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });
  });

  // A registry eseményei -> minden csatlakozott kliens.
  registry.on('scan', (robots) => io.emit('scan', { robots }));
  registry.on('robot', (robot) => io.emit('robot', robot));
  registry.on('telemetry', (robot) => io.emit('telemetry', robot));
  // a REST-en kiadott parancs eredménye is menjen a socketre
  registry.on('command', (result) => io.emit('command-result', result));
  // a BLE réteg hibái (hibás csomag, megszakadt kapcsolat) — ezeket a felületnek
  // is látnia kell, nem csak a szerver naplójában
  registry.on('robot-error', (payload) => io.emit('robot-error', payload));
  // a mikrofon értékei (a felület szintmérője)
  registry.on('mic', (payload) => io.emit('mic', payload));

  return { io };
}
