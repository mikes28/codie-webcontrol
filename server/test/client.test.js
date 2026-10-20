/**
 * A BLE kliens viselkedésének tesztje a hamis robottal.
 *
 * Ezek a regressziós tesztek a valódi hibákat fogják: a ritmus időzítése
 * (a Python `asyncio.sleep` másodpercet vár, a JS `sleep` ezredmásodpercet),
 * a `status()` nem várhat válaszra olyan parancsra, ami sosem jön, és a
 * `_pending` nem szivárgathat sikertelen write után.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CodieClient } from '../src/ble/client.js';
import { FakeCodie, FakeScanner } from './fake-robot.js';

async function connectedClient(robot = new FakeCodie()) {
  const scanner = new FakeScanner([robot]);
  const client = new CodieClient({
    address: robot.address,
    noble: null,
    scanner,
    timeout: 2000,
    scanWindow: 1000,
    connectRetries: 1,
    retryDelay: 10,
    responseTimeout: 300,
  });
  await client.connect();
  return { client, robot };
}

test('a ritmus a valódi időzítéssel szól (nem 1000x rövidebbel)', async () => {
  const { client } = await connectedClient();
  const started = Date.now();
  await client.playRhythm([
    [120, 80],
    [120, 80],
  ]);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 380, `a ritmusnak legalább 400 ms-t kell várnia, mért: ${elapsed} ms`);
});

test('a Morse legalább a jelek összegének ideje alatt fut', async () => {
  const { client } = await connectedClient();
  const started = Date.now();
  await client.playMorse('E', 100); // egyetlen pont: 100 ms hang
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 90, `a Morse-jelnek hallhatónak kell lennie, mért: ${elapsed} ms`);
});

test('a status() nem vár a feszültségre, ami sosem jön', async () => {
  const { client } = await connectedClient();
  const started = Date.now();
  const status = await client.status();
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 250, `a status-nak gyorsnak kell lennie, mért: ${elapsed} ms`);
  assert.equal(status.batteryPct, 85);
  assert.equal('voltageMv' in status, false, 'a feszültség nem része a status-nak');
});

test('a sikertelen write nem szivárogtat _pending bejegyzést', async () => {
  const { client } = await connectedClient();
  const writeChar = client._writeChar;
  client._writeChar = {
    uuid: writeChar.uuid,
    writeAsync: async () => {
      throw new Error('BLE write hiba');
    },
  };
  await assert.rejects(() => client.send(0x1069), /BLE write hiba/);
  assert.equal(client._pending.size, 0, 'a _pending üres marad');
});

test('a notify-history korlátolt, nem nő a végtelenig', async () => {
  const { client, robot } = await connectedClient();
  for (let i = 0; i < 150; i += 1) {
    await client.battery();
  }
  assert.ok(client.notifications.length <= 100, `a history korlátolt kell legyen, mért: ${client.notifications.length}`);
  assert.ok(robot.received.length >= 150);
});

test('a lekapcsolódás egyetlen eseményt jelez', async () => {
  const { client } = await connectedClient();
  let events = 0;
  client.on('disconnected', () => {
    events += 1;
  });
  await client.disconnect();
  assert.equal(events, 1, 'pontan egy disconnected esemény');
});
