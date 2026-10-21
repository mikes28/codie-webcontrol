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
import { FakeCodie, FakeNoble, FakeScanner } from './fake-robot.js';

async function connectedClient(robot = new FakeCodie()) {
  const scanner = new FakeScanner([robot]);
  const client = new CodieClient({
    address: robot.address,
    noble: new FakeNoble([robot]),
    scanner,
    timeout: 2000,
    scanWindow: 1000,
    connectRetries: 1,
    retryDelay: 10,
    responseTimeout: 300,
    writeGap: 0, // a teszt ne várjon BLE-szünetet (a szünet külön tesztelt)
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

test('a kliens "error" eseménye nem dob (a hibás BLE-csomag nem öli meg a szervert)', async () => {
  const { client } = await connectedClient();
  const seen = [];
  client.on('ble-error', (error) => seen.push(error));
  // A Node EventEmitter a 'error' eseményt listener nélkül kidobja — a kliens
  // beépített listenerje miatt ez nem szakítja meg a szervert.
  client.emit('error', new Error('hibás BLE-csomag'));
  assert.equal(seen.length, 1, 'a hiba a ble-error eseményen jelenik meg');
  assert.match(seen[0].message, /hibás BLE-csomag/);
});

test('két párhuzamos írás közt is betart a kötelező szünet', async () => {
  const { client } = await connectedClient();
  // a szünet csak a routing nélküli firmware-nél érvényes (ott dobja el az
  // átfedő üzeneteket) — a routingos generáció a párhuzamos kéréseket bírja
  client._variant = 'no-routing';
  const times = [];
  const writeChar = client._writeChar;
  client._writeChar = {
    uuid: writeChar.uuid,
    writeAsync: async () => {
      times.push(Date.now());
    },
  };
  // A lekérdezési és az akciósor két külön lánc — ha a szünet nem lenne
  // szinkron foglalva, a két üzenet ugyanabban a milliszekundban menne ki,
  // és a firmware eldobná az egyiket.
  await Promise.all([
    client._writeGatt(client._writeChar, Buffer.from([1]), { minGap: 60 }),
    client._writeGatt(client._writeChar, Buffer.from([2]), { minGap: 60 }),
  ]);
  assert.equal(times.length, 2);
  const gap = times[1] - times[0];
  assert.ok(gap >= 45, `a két írás közt legalább 60 ms kell, mért: ${gap} ms`);
});

test('az újracsatlakozás nem halmozza a BLE-listener-eket a karakterisztikán', async () => {
  // A noble cache-eli a karakterisztikákat, így minden új kliens ugyanarra a
  // példányra kötne új 'data' listenert — a halmozódás a Node-on figyelmeztetést
  // (MaxListenersExceededWarning) okoz, és minden notify-t minden régi kliens
  // feldolgozna.
  const robot = new FakeCodie();
  const notifyChar = robot._notifyChar;

  const first = await connectedClient(robot);
  assert.equal(notifyChar.listenerCount('data'), 1, 'egy kapcsolat = egy listener');
  await first.client.disconnect();
  assert.equal(notifyChar.listenerCount('data'), 0, 'a lekapcsolódás leveszi a listenert');

  const second = await connectedClient(robot);
  assert.equal(notifyChar.listenerCount('data'), 1, 'az újracsatlakozás után is egy listener');
  await second.client.disconnect();
});

test('a LED-animáció a routingos generációban hibát ad (a paraméterei nem dokumentáltak)', async () => {
  const { client } = await connectedClient();
  // a routingos firmware animáció-parancsa (0x1066) argumentumai nincsenek
  // dokumentálva → nem találgatunk, hanem szabályos hibát adunk
  await assert.rejects(() => client.ledAnimation(0), /routing nélküli generációban/);
});
