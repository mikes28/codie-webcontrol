/** A REST API tesztje — hamis registry-vel, BLE hardver nélkül. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp } from '../src/app.js';

function fakeRegistry() {
  const robot = {
    address: '00:07:80:66:F0:DB',
    name: 'Codie',
    rssi: -55,
    connected: true,
    seen: true,
    telemetry: { batteryPct: 90, sonarMm: 300, lightRaw: 12, line: { left: 1, right: 0 } },
    reasons: ['name'],
  };
  const calls = [];
  return {
    calls,
    list: () => [robot],
    get: (address) => (address === robot.address ? robot : null),
    scan: async ({ durationMs }) => {
      calls.push(['scan', durationMs]);
      return [robot];
    },
    connect: async (address) => {
      calls.push(['connect', address]);
      return robot;
    },
    disconnect: async (address) => {
      calls.push(['disconnect', address]);
      return { ...robot, connected: false };
    },
    command: async (address, name, params) => {
      calls.push(['command', address, name, params]);
      if (name === 'nope') {
        // a valós parancsréteg a validációs hibákat 400-as státusszal jelöli
        const error = new Error('Ismeretlen parancs: nope');
        error.status = 400;
        throw error;
      }
      if (name === 'boom') throw new Error('belső hiba');
      return { action: name };
    },
  };
}

async function withServer(run) {
  const registry = fakeRegistry();
  const app = createApp({ registry, filters: { nameFilter: 'Codie', scanMs: 10000 } });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await run({ base, registry });
  } finally {
    server.close();
  }
}

test('a health végpont működik', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });
});

test('a robotlista a registry-t adja vissza', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/robots`);
    const body = await res.json();
    assert.equal(body.robots.length, 1);
    assert.equal(body.robots[0].address, '00:07:80:66:F0:DB');
  });
});

test('a scan végpont a registry-t hívja', async () => {
  await withServer(async ({ base, registry }) => {
    const res = await fetch(`${base}/api/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ durationMs: 5000 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.robots.length, 1);
    assert.deepEqual(registry.calls[0], ['scan', 5000]);
  });
});

test('a csatlakozás és a parancs címe a route-ból jön', async () => {
  await withServer(async ({ base, registry }) => {
    const connect = await fetch(`${base}/api/robots/00:07:80:66:F0:DB/connect`, { method: 'POST' });
    assert.equal(connect.status, 200);

    const command = await fetch(`${base}/api/robots/00:07:80:66:F0:DB/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'led', params: { color: 'red' } }),
    });
    assert.equal(command.status, 200);
    assert.deepEqual(registry.calls.at(-1), ['command', '00:07:80:66:F0:DB', 'led', { color: 'red' }]);
  });
});

test('a hiba JSON-ban jön vissza', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/robots/00:07:80:66:F0:DB/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nope' }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /Ismeretlen parancs/);
  });
});

test('a nem validációs hiba 500-as státusszal jön', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/robots/00:07:80:66:F0:DB/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'boom' }),
    });
    assert.equal(res.status, 500);
  });
});

test('ismeretlen robotra 404', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/robots/11:22:33:44:55:66`);
    assert.equal(res.status, 404);
  });
});

test('a telemetria végpont', async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/robots/00:07:80:66:F0:DB/telemetry`);
    const body = await res.json();
    assert.equal(body.telemetry.batteryPct, 90);
  });
});
