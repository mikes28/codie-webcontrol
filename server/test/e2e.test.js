/**
 * Végponttól végpontig teszt a hamis robottal: a valódi `RobotRegistry`,
 * `CodieClient`, parancsréteg, Express API és socket.io réteg fut a sorban —
 * csak a BLE rádió helyett a `test/fake-robot.js` emulálja a robotot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';

import { createApp } from '../src/app.js';
import { attachRealtime } from '../src/realtime.js';
import { RobotRegistry } from '../src/ble/registry.js';
import { FakeCodie, FakeNoble, FakeScanner } from './fake-robot.js';
import {
  FakeNoRoutingCodie,
  FakeNoRoutingNoble,
  FakeNoRoutingScanner,
} from './fake-robot-norrouting.js';

const FILTERS = {
  nameFilter: 'Codie',
  serviceUuids: ['52af0001-978a-628d-c845-0a104ca2b8dd', 'd46e7e53ba2f4044ade9f85ead45f458'],
  macAllowlist: [],
  macOnly: false,
};

/** Más BLE eszközök, amiket a szűrőnek ki kell zárnia. */
function otherPeripheral(id, name) {
  return {
    id,
    advertisement: { localName: name, serviceUuids: ['110b', '180f'] },
    rssi: -70,
  };
}

function buildStack() {
  const robot = new FakeCodie();
  const noble = new FakeNoble([
    robot,
    otherPeripheral('001e7ccaec16', 'HAYLOU S35 ANC'),
    otherPeripheral('0013d69908a1', 'Redmi Buds 6 Play'),
    otherPeripheral('3c135a1637ea', 'Redmi Note 12 Pro'),
  ]);
  const registry = new RobotRegistry({
    noble,
    filters: FILTERS,
    scanner: new FakeScanner([robot]),
    telemetryMs: 0,
    // az újracsatlakozást a tesztben gyorsan akarjuk látni
    reconnectDelayMs: 20,
    reconnectAttempts: 2,
  });
  return { robot, noble, registry };
}

test('a scan csak a robotot találja meg', async () => {
  const { registry } = buildStack();
  const robots = await registry.scan({ durationMs: 100 });
  assert.equal(robots.length, 1);
  assert.equal(robots[0].name, 'Codie');
  assert.equal(robots[0].address, '00:07:80:66:F0:DB');
});

test('a connect + parancs a valódi kliensen fut le', async () => {
  const { registry, robot } = buildStack();
  await registry.scan({ durationMs: 100 });
  await registry.connect('00:07:80:66:F0:DB');

  const status = await registry.command('00:07:80:66:F0:DB', 'status', {});
  assert.equal(status.status.batteryPct, 85);
  assert.equal(status.status.sonarMm, 300);
  assert.equal(status.status.lightRaw, 4041);
  assert.deepEqual(status.status.line, { left: 3895, right: 3808 });

  const battery = await registry.command('00:07:80:66:F0:DB', 'battery', {});
  assert.equal(battery.pct, 85);

  await registry.command('00:07:80:66:F0:DB', 'led', { color: 'red' });
  assert.equal(robot.lastLed.mask, 0x0fff);
  assert.deepEqual([robot.lastLed.hue, robot.lastLed.sat, robot.lastLed.value], [0, 255, 255]);

  await registry.command('00:07:80:66:F0:DB', 'beep', { ms: 300 });
  assert.equal(robot.lastBeep.durationMs, 300);

  await registry.command('00:07:80:66:F0:DB', 'forward', { cm: 12 });
  assert.deepEqual(robot.lastDistance, { distanceMm: 120, left: 40, right: 40 });

  await registry.command('00:07:80:66:F0:DB', 'turn', { degrees: 90 });
  assert.deepEqual(robot.lastTurn, { degree: 90, speed: -40 });

  await registry.command('00:07:80:66:F0:DB', 'stop', {});
  assert.deepEqual(robot.lastDrive, { left: 0, right: 0 });
});

test('a kétszeri connect nem töri el a kapcsolatot', async () => {
  const { registry } = buildStack();
  await registry.connect('00:07:80:66:F0:DB');
  const again = await registry.connect('00:07:80:66:F0:DB');
  assert.equal(again.connected, true);
  const battery = await registry.command('00:07:80:66:F0:DB', 'battery', {});
  assert.equal(battery.pct, 85);
});

test('a párhuzamos connect sem töri el a registry-t', async () => {
  const { registry } = buildStack();
  const [first, second] = await Promise.all([
    registry.connect('00:07:80:66:F0:DB'),
    registry.connect('00:07:80:66:F0:DB'),
  ]);
  assert.equal(first.connected, true);
  assert.equal(second.connected, true);
  const battery = await registry.command('00:07:80:66:F0:DB', 'battery', {});
  assert.equal(battery.pct, 85, 'a robot parancsot fogad — a registry nem korrupt');
});

test('a telemetria a státuszból épül', async () => {
  const { registry } = buildStack();
  await registry.connect('00:07:80:66:F0:DB');
  await registry._pollTelemetry();
  const robot = registry.get('00:07:80:66:F0:DB');
  assert.equal(robot.telemetry.batteryPct, 85);
  assert.equal(robot.telemetry.sonarMm, 300);
  assert.ok(robot.telemetry.updatedAt > 0);
});

test('a REST API a hamis robottal is végigfut', async () => {
  const { registry } = buildStack();
  const app = createApp({ registry, filters: FILTERS });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const scan = await fetch(`${base}/api/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ durationMs: 100 }),
    });
    const scanBody = await scan.json();
    assert.equal(scanBody.robots.length, 1);

    const connect = await fetch(`${base}/api/robots/00:07:80:66:F0:DB/connect`, { method: 'POST' });
    assert.equal(connect.status, 200);
    assert.equal((await connect.json()).connected, true);

    const command = await fetch(`${base}/api/robots/00:07:80:66:F0:DB/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'battery' }),
    });
    const commandBody = await command.json();
    assert.equal(commandBody.pct, 85);

    const telemetry = await fetch(`${base}/api/robots/00:07:80:66:F0:DB/telemetry`);
    assert.equal((await telemetry.json()).address, '00:07:80:66:F0:DB');
  } finally {
    server.close();
  }
});

test('a REST API a routing nélküli generáción is végigfut (a LED-animációval)', async () => {
  const robot = new FakeNoRoutingCodie();
  const registry = new RobotRegistry({
    noble: new FakeNoRoutingNoble([robot]),
    filters: FILTERS,
    scanner: new FakeNoRoutingScanner([robot]),
    telemetryMs: 0,
  });
  const app = createApp({ registry, filters: FILTERS });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const address = robot.address;

  try {
    const connect = await fetch(`${base}/api/robots/${address}/connect`, { method: 'POST' });
    assert.equal(connect.status, 200);
    assert.equal((await connect.json()).connected, true);

    const command = await fetch(`${base}/api/robots/${address}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'ledAnim', params: { animation: 1, color: 'blue' } }),
    });
    assert.equal(command.status, 200);
    const body = await command.json();
    assert.equal(body.action, 'ledAnim');
    assert.equal(body.animation, 1);
    // a frame a robotig ért: animáció 1, a kék szín a firmware skáláján
    // (a táblázatban a hue 0-255 skálán 170 → floor((170/255)*360*0,7) = 168;
    //  a sat: round((255/255)*100*2,55) = 255)
    assert.equal(robot.lastAnimation.animation, 1);
    assert.equal(robot.lastAnimation.hue, 168);
    assert.equal(robot.lastAnimation.sat, 255);
  } finally {
    server.close();
  }
});

test('a socket.io réteg továbbítja az eseményeket', async () => {
  const { registry } = buildStack();
  const app = createApp({ registry, filters: FILTERS });
  const httpServer = createServer(app);
  const io = new Server(httpServer);
  attachRealtime({ io, registry });
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;

  const client = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] });
  const events = [];
  client.on('scan', (payload) => events.push(['scan', payload.robots.length]));
  client.on('robot', (robot) => events.push(['robot', robot.address]));

  try {
    await new Promise((resolve, reject) => {
      client.on('connect', resolve);
      client.on('connect_error', reject);
    });

    client.emit('scan:request', { durationMs: 100 });
    await waitFor(() => events.some(([name]) => name === 'scan'));

    client.emit('robot:connect', { address: '00:07:80:66:F0:DB' });
    await waitFor(() => events.some(([name]) => name === 'robot'));

    const scan = events.find(([name]) => name === 'scan');
    assert.equal(scan[1], 1, 'csak egy robot a scan eredménye');
    const robot = events.find(([name]) => name === 'robot');
    assert.equal(robot[1], '00:07:80:66:F0:DB');
  } finally {
    client.close();
    io.close();
    httpServer.close();
  }
});

test('a váratlanul megszakadt kapcsolat után a registry újracsatlakozik', async () => {
  const { registry, robot } = buildStack();
  await registry.connect('00:07:80:66:F0:DB');
  assert.equal(registry.get('00:07:80:66:F0:DB').connected, true);

  // a link megszakad (a robot elalvelt vagy a BLE-kapcsolat szakadt meg)
  robot.emit('disconnect', 'remote');
  await waitFor(() => registry.get('00:07:80:66:F0:DB').reconnecting === true, 2000);
  await waitFor(() => registry.get('00:07:80:66:F0:DB').connected === true, 5000);
});

test('a felhasználó által kért lekapcsolás nem indít újracsatlakozást', async () => {
  const { registry } = buildStack();
  await registry.connect('00:07:80:66:F0:DB');
  await registry.disconnect('00:07:80:66:F0:DB');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const robot = registry.get('00:07:80:66:F0:DB');
  assert.equal(robot.connected, false);
  assert.equal(robot.reconnecting, false);
});

test('a felismert generáció megmarad lekapcsolás után is', async () => {
  const { registry } = buildStack();
  await registry.connect('00:07:80:66:F0:DB');
  assert.equal(registry.get('00:07:80:66:F0:DB').variant, 'routing');
  await registry.disconnect('00:07:80:66:F0:DB');
  assert.equal(registry.get('00:07:80:66:F0:DB').variant, 'routing');
});

test('a BLE hiba a registry-n keresztül a felülethez jut', async () => {
  const { registry } = buildStack();
  const errors = [];
  registry.on('robot-error', (payload) => errors.push(payload));
  await registry.connect('00:07:80:66:F0:DB');
  const client = registry.clientFor('00:07:80:66:F0:DB');
  client.emit('error', new Error('hibás BLE-csomag'));
  assert.equal(errors.length, 1, 'a BLE hiba robot-error eseményként jelenik meg');
  assert.match(errors[0].message, /hibás BLE-csomag/);
});

test('a telemetria érzékelőnként érkezik (nem csak a teljes lekérés végén)', async () => {
  const { registry } = buildStack();
  await registry.connect('00:07:80:66:F0:DB');
  const events = [];
  registry.on('telemetry', (robot) => events.push(robot.telemetry));
  await registry._pollTelemetry();
  assert.ok(events.length >= 4, `minden érzékelő külön eseményt kap, mért: ${events.length}`);
  const last = events.at(-1);
  assert.equal(last.batteryPct, 85);
  assert.equal(last.sonarMm, 300);
  assert.equal(last.lightRaw, 4041);
  assert.deepEqual(last.line, { left: 3895, right: 3808 });
});

test('a mikrofon figyelése nyers értéket és szintet ad', async () => {
  const { registry } = buildStack();
  await registry.connect('00:07:80:66:F0:DB');
  const values = [];
  registry.on('mic', (payload) => values.push(payload));
  registry.startMicStream('00:07:80:66:F0:DB');
  await waitFor(() => values.length > 0, 2000);
  const value = values.at(-1);
  assert.equal(value.address, '00:07:80:66:F0:DB');
  assert.equal(value.raw, 633); // a hamis robot mikrofonértéke
  assert.equal(value.level, Math.round((633 / 2048) * 100));
  assert.ok(value.peak >= value.level - 1, 'a csúcs nem kisebb a szintnél');
  registry.stopMicStream('00:07:80:66:F0:DB');
  assert.equal(registry.get('00:07:80:66:F0:DB').micStreaming, false);
});

test('a mikrofon figyeléséhez csatlakoztatott robot kell', async () => {
  const { registry } = buildStack();
  assert.throws(() => registry.startMicStream('00:07:80:66:F0:DB'), /nincs csatlakoztatva/);
});

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout a socket eseményre'));
      setTimeout(tick, 20);
    };
    tick();
  });
}
