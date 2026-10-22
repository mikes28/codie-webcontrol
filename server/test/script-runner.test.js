/**
 * A robot-scriptek futtatójának tesztje.
 *
 * A Python kommunikációs script valódi subprocess: a teszt egy hamis
 * backendet indít (HTTP), a script azt hívja, és a Node-oldali futtató
 * eseményeit figyeljük. Ha a python3 hiányzik, a teszt kimarad.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

import { createApp } from '../src/app.js';
import { attachRealtime } from '../src/realtime.js';
import { ScriptRunner, firmwareSurface, listScripts } from '../src/scripts.js';
import { Server } from 'socket.io';
import { io as Client } from 'socket.io-client';

const ADDRESS = '00:07:80:66:F0:DB';

function hasPython() {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const pythonAvailable = hasPython();

/** A hamis backend: a parancsokat feljegyzi, és a szenzorokat válaszolja. */
function fakeBackend() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url.endsWith('/command')) {
        const parsed = JSON.parse(body || '{}');
        calls.push([parsed.name, parsed.params || {}]);
        res.end(JSON.stringify({ address: ADDRESS, action: parsed.name }));
        return;
      }
      if (req.method === 'GET' && req.url.endsWith('/robots')) {
        res.end(JSON.stringify({ robots: [{ address: ADDRESS, connected: true }] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Ismeretlen robot cím.' }));
    });
  });
  return { calls, server };
}

function fakeRegistry() {
  return {
    list: () => [{ address: ADDRESS, name: 'Codie', connected: true }],
    get: (address) => (address === ADDRESS ? { address, connected: true } : null),
    command: async () => ({ action: 'noop' }),
    // a valós registry EventEmitter — a realtime réteg ezen figyel
    on: () => {},
    emit: () => {},
  };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('a scriptek listája a Python oldaltól jön', { skip: pythonAvailable ? false : 'python3 hiányzik' }, async () => {
  const scripts = await listScripts();
  const names = scripts.map((item) => item.name);
  assert.ok(names.includes('square'), 'a négyzetes kör script benne van');
  const square = scripts.find((item) => item.name === 'square');
  assert.ok(square.title, 'a scriptnek van címe');
  assert.ok(square.description, 'a scriptnek van leírása');
});

test('a firmware-regiszter a visszafejtett interfészeket adja', { skip: pythonAvailable ? false : 'python3 hiányzik' }, async () => {
  const surface = await firmwareSurface();
  assert.equal(surface.interfaces.length, 16, 'a 16 interfész megvan');
  assert.equal(surface.version, '0.5.0hw2.1');

  const battery = surface.interfaces.find((item) => item.name === 'drvBattery');
  const voltage = battery.ops.find((op) => op.name === 'voltage');
  assert.equal(voltage.radix, 16, 'a feszültség hexadecimálisan jön');
  assert.equal(voltage.replyWord, 'set', 'a válasz szava a set');

  const drive = surface.interfaces.find((item) => item.name === 'hwiDrive');
  const duty = drive.ops.find((op) => op.name === 'dutyA');
  assert.equal(duty.replies, false, 'a motor-op nem válaszol');
});

test('a REST végpontok elindítják és leállítják a scriptet', { skip: pythonAvailable ? false : 'python3 hiányzik' }, async () => {
  const backend = fakeBackend();
  const apiUrl = await listen(backend.server);
  const runner = new ScriptRunner({ timeoutMs: 20000 });
  runner.setApiUrl(apiUrl);

  const events = [];
  runner.on('event', (payload) => events.push(payload));

  try {
    runner.start(ADDRESS, 'square');

    const exit = await new Promise((resolve) => {
      runner.on('exit', resolve);
    });
    assert.equal(exit.code, 0, 'a script hiba nélkül lefutott');

    const names = events.map((event) => event.event);
    assert.ok(names.includes('start'), 'volt start esemény');
    assert.ok(names.includes('step'), 'volt lépés esemény');
    assert.ok(names.includes('done'), 'volt done esemény');

    const actions = backend.calls.map(([name]) => name);
    assert.ok(actions.includes('forward'), 'a script előre ment');
    assert.ok(actions.includes('turn'), 'a script fordult');
    assert.ok(actions.includes('stop'), 'a script végén megállította a robotot');
  } finally {
    runner.stopAll();
    backend.server.close();
  }
});

test('a REST végpontok elindítják és leállítják a scriptet', { skip: pythonAvailable ? false : 'python3 hiányzik' }, async () => {
  const backend = fakeBackend();
  const apiUrl = await listen(backend.server);
  const runner = new ScriptRunner({ timeoutMs: 20000 });
  runner.setApiUrl(apiUrl);

  const app = createApp({ registry: fakeRegistry(), scripts: runner });
  const appServer = app.listen(0);
  await new Promise((resolve) => appServer.once('listening', resolve));
  const base = `http://127.0.0.1:${appServer.address().port}`;

  try {
    const list = await fetch(`${base}/api/scripts`);
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.ok(listBody.scripts.length > 0, 'a scriptek listája nem üres');

    const firmware = await fetch(`${base}/api/firmware`);
    assert.equal(firmware.status, 200);
    const firmwareBody = await firmware.json();
    assert.equal(firmwareBody.interfaces.length, 16, 'a firmware interfészei megvannak');

    const start = await fetch(`${base}/api/robots/${ADDRESS}/script`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'square' }),
    });
    assert.equal(start.status, 200);

    const status = await fetch(`${base}/api/robots/${ADDRESS}/script`);
    const statusBody = await status.json();
    assert.equal(statusBody.script.script, 'square', 'a futó script látszik');

    // egy második indítás ugyanarra a robotra 409
    const again = await fetch(`${base}/api/robots/${ADDRESS}/script`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'square' }),
    });
    assert.equal(again.status, 409);

    const stop = await fetch(`${base}/api/robots/${ADDRESS}/script`, { method: 'DELETE' });
    assert.equal(stop.status, 200);
    assert.equal((await stop.json()).stopped, true);
  } finally {
    runner.stopAll();
    appServer.close();
    backend.server.close();
  }
});

test('a script neve nélkül a start 400', async () => {
  const app = createApp({ registry: fakeRegistry(), scripts: new ScriptRunner() });
  const appServer = app.listen(0);
  await new Promise((resolve) => appServer.once('listening', resolve));
  const base = `http://127.0.0.1:${appServer.address().port}`;
  try {
    const res = await fetch(`${base}/api/robots/${ADDRESS}/script`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  } finally {
    appServer.close();
  }
});

test('a script eseményei a socketen is megjelenneek', { skip: pythonAvailable ? false : 'python3 hiányzik' }, async () => {
  const backend = fakeBackend();
  const apiUrl = await listen(backend.server);
  const runner = new ScriptRunner({ timeoutMs: 20000 });
  runner.setApiUrl(apiUrl);

  const registry = fakeRegistry();
  const app = createApp({ registry, scripts: runner });
  const httpServer = http.createServer(app);
  const io = new Server(httpServer);
  const events = [];
  let connected = null;

  try {
    attachRealtime({ io, registry, scripts: runner });
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${httpServer.address().port}`;

    connected = new Client(base, { transports: ['websocket'] });
    connected.on('script:event', (payload) => events.push(payload));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('a socket-kliens nem csatlakozott')), 10000);
      connected.on('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      connected.on('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const start = await fetch(`${base}/api/robots/${ADDRESS}/script`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'square' }),
    });
    assert.equal(start.status, 200);

    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (events.some((event) => event.event === 'done')) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, 15000);
    });

    assert.ok(events.length > 0, 'érkezett socket-esemény');
    assert.ok(
      events.some((event) => event.event === 'done'),
      'a done esemény is megérkezett',
    );
    assert.ok(
      events.every((event) => event.address === ADDRESS),
      'minden esemény a robot címével jön',
    );
  } finally {
    connected?.close();
    runner.stopAll();
    io.close();
    httpServer.close();
    backend.server.close();
  }
});
