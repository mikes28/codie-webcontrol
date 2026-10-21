/**
 * Szerver indítása: Express + socket.io + BLE registry.
 *
 *   node src/index.js
 *
 * A konfiguráció környezeti változókból jön (lásd: `src/config.js`).
 */

'use strict';

import { createServer } from 'node:http';

import { Server } from 'socket.io';

import { config, registryOptions } from './config.js';
import { createApp } from './app.js';
import { attachRealtime } from './realtime.js';
import { getNoble, ensurePoweredOn } from './ble/noble.js';
import { RobotRegistry } from './ble/registry.js';

export async function startServer(options = {}) {
  const settings = options.config || config;
  const noble = options.noble || getNoble({ adapterId: settings.ble.adapterId });

  const registry =
    options.registry ||
    new RobotRegistry({
      noble,
      filters: settings.ble,
      ...registryOptions(settings.ble),
    });

  const app = createApp({ registry, filters: settings.ble });
  const server = createServer(app);
  const io = new Server(server, {
    cors: { origin: true, credentials: true },
  });
  attachRealtime({ io, registry });

  await new Promise((resolve) => {
    server.listen(settings.port, settings.host, resolve);
  });

  const address = server.address();
  console.log(`[codie] szerver listening: http://${settings.host}:${address.port}`);
  console.log(
    `[codie] robot-szűrő: név="${settings.ble.nameFilter}" uuid=${settings.ble.serviceUuids.join(',')} ` +
      `allowlist=${settings.ble.macAllowlist.join(',') || '(nincs)'}`,
  );

  try {
    await ensurePoweredOn(noble, 10000);
    console.log(`[codie] BLE adapter (${settings.ble.adapterId}) kész.`);
  } catch (error) {
    console.warn(`[codie] BLE adapter nem elérhető: ${error.message}`);
  }

  for (const addressToConnect of settings.autoConnect) {
    registry
      .connect(addressToConnect)
      .then((robot) => console.log(`[codie] csatlakozva: ${robot.address} (${robot.name})`))
      .catch((error) => console.warn(`[codie] csatlakozás sikertelen (${addressToConnect}): ${error.message}`));
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[codie] leállás...');
    await registry.disconnectAll();
    io.close();
    try {
      noble.stop?.();
    } catch {
      /* a BLE kapcsolat lezárása nem kritikus */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  // a jelzőkezelők csak egyszer fussanak (a startServer újra hívható)
  if (process.listenerCount('SIGINT') === 0) {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  return { app, server, io, registry, noble };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    console.error('[codie] indítási hiba:', error);
    process.exit(1);
  });
}
