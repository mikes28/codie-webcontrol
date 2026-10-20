/**
 * socket.io réteg — a szerver és a (későbbi) frontend közötti valós idejű csatorna.
 *
 * A szerver a registry eseményeit továbbítja ('scan', 'robot', 'telemetry'),
 * a kliens pedig ugyanazokat a műveleteket kérheti, mint a REST API
 * ('scan:request', 'robot:connect', 'robot:disconnect', 'robot:command').
 */

'use strict';

export function attachRealtime({ io, registry }) {
  io.on('connection', (socket) => {
    socket.emit('robots', { robots: registry.list() });

    socket.on('scan:request', async (payload = {}) => {
      try {
        const durationMs = Math.min(Math.max(Number(payload.durationMs ?? 10000), 1000), 120000);
        const robots = await registry.scan({ durationMs });
        socket.emit('scan', { robots, durationMs });
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
        const result = await registry.command(payload.address, payload.name, payload.params ?? {});
        socket.emit('command-result', { address: payload.address, ...result });
      } catch (error) {
        socket.emit('error', { message: error.message });
      }
    });
  });

  // A registry eseményei -> minden csatlakozott kliens.
  registry.on('scan', (robots) => io.emit('scan', { robots }));
  registry.on('robot', (robot) => io.emit('robot', robot));
  registry.on('telemetry', (robot) => io.emit('telemetry', robot));

  return { io };
}
