/** A magas szintű parancsok szemantikája (a REST, a CLI és a konzol közös rétege). */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runCommand } from '../src/commands.js';

function fakeClient() {
  const calls = [];
  // a valódi kliens a nyugtát adja vissza (a parancsréteg ezt ellenőrzi)
  const record = (name) => async (...args) => {
    calls.push([name, ...args]);
    return { ok: true };
  };
  return {
    calls,
    beep: record('beep'),
    ledAll: record('ledAll'),
    ledSingle: record('ledSingle'),
    ledsOff: record('ledsOff'),
    ledAnimation: record('ledAnimation'),
    playMorse: record('playMorse'),
    playTune: record('playTune'),
    driveDistance: record('driveDistance'),
    driveTurn: record('driveTurn'),
    driveSpeed: record('driveSpeed'),
    // a valódi kliensben a stop() a driveSpeed(0, 0)-at hívja
    stop: async () => {
      calls.push(['driveSpeed', 0, 0]);
      return { ok: true };
    },
    status: async () => ({ batteryPct: 88, sonarMm: 320, lightRaw: 100, line: { left: 1, right: 2 } }),
    battery: async () => 88,
    sonar: async () => 320,
    light: async () => 100,
    line: async () => ({ left: 1, right: 2 }),
    mic: async () => 512,
  };
}

test('a led parancs az összes LED-et állítja', async () => {
  const client = fakeClient();
  const result = await runCommand(client, 'led', { color: 'red' });
  assert.deepEqual(client.calls, [['ledAll', 'red']]);
  assert.equal(result.color, 'red');
});

test('a ledSingle egy megadott indexet állít', async () => {
  const client = fakeClient();
  await runCommand(client, 'ledSingle', { color: 'blue', index: 4 });
  assert.deepEqual(client.calls, [['ledSingle', 'blue', 4]]);
});

test('a ledAnim a beépített animációt indítja a megadott színnel', async () => {
  const client = fakeClient();
  const result = await runCommand(client, 'ledAnim', {
    animation: 1,
    color: 'blue',
    repeat: 2,
    speed: 30,
  });
  assert.deepEqual(client.calls, [['ledAnimation', 1, { color: 'blue', repeat: 2, speed: 30 }]]);
  assert.equal(result.action, 'ledAnim');
  assert.equal(result.animation, 1);
});

test('a ledAnim animációs sorszáma 0 vagy 1 lehet (a codiejs szerint)', async () => {
  const client = fakeClient();
  const result = await runCommand(client, 'ledAnim', { animation: 7 });
  // a parancsréteg a tartományra vág (a forward cm-es korlátjához hasonlóan)
  assert.equal(result.animation, 1);
  assert.deepEqual(client.calls, [['ledAnimation', 1, { color: 'red', repeat: 0, speed: 10 }]]);
});

test('az előrehaladás cm-t milliméterre vált és 200 cm-re vág', async () => {
  const client = fakeClient();
  await runCommand(client, 'forward', { cm: 25 });
  assert.deepEqual(client.calls, [['driveDistance', 250, 40, 40]]);

  const other = fakeClient();
  await runCommand(other, 'forward', { cm: 5000 });
  assert.deepEqual(other.calls, [['driveDistance', 2000, 40, 40]]);
});

test('a hátrahaladás negatív sebességgel megy', async () => {
  const client = fakeClient();
  await runCommand(client, 'backward', { cm: 10 });
  assert.deepEqual(client.calls, [['driveDistance', 100, -40, -40]]);
});

test('a fordulás előjele: pozitív fok = jobbra = negatív speed', async () => {
  const client = fakeClient();
  await runCommand(client, 'turn', { degrees: 90 });
  await runCommand(client, 'turn', { degrees: -90 });
  assert.deepEqual(client.calls, [
    ['driveTurn', 90, -40],
    ['driveTurn', 90, 40],
  ]);
});

test('a fordulás 360 fokra vág', async () => {
  const client = fakeClient();
  await runCommand(client, 'turn', { degrees: 720 });
  assert.deepEqual(client.calls, [['driveTurn', 360, -40]]);
});

test('a stop nullára állítja a kerekeket', async () => {
  const client = fakeClient();
  await runCommand(client, 'stop', {});
  assert.deepEqual(client.calls, [['driveSpeed', 0, 0]]);
});

test('a beep időtartalma 1..10000 ms közé vág', async () => {
  const client = fakeClient();
  await runCommand(client, 'beep', { ms: 0 });
  await runCommand(client, 'beep', { ms: 99999 });
  assert.deepEqual(client.calls, [
    ['beep', 1],
    ['beep', 10000],
  ]);
});

test('a Morse-szöveg továbbad', async () => {
  const client = fakeClient();
  await runCommand(client, 'morse', { text: 'SOS' });
  assert.deepEqual(client.calls, [['playMorse', 'SOS', 120]]);
});

test('a Morse unit paramétere hibás értéknél hibát dob', async () => {
  const client = fakeClient();
  await assert.rejects(() => runCommand(client, 'morse', { text: 'SOS', unitMs: 'abc' }), /véges szám/);
  assert.deepEqual(client.calls, [], 'egyetlen parancs se indult el');
  // a túl kicsi érték vágva van (nem hiba), mint a többi számparaméter
  await runCommand(client, 'morse', { text: 'SOS', unitMs: 1 });
  assert.deepEqual(client.calls, [['playMorse', 'SOS', 10]]);
});

test('az ismeretlen parancs hibát dob', async () => {
  await assert.rejects(() => runCommand(fakeClient(), 'fly', {}), /Ismeretlen parancs/);
});

test('a nem számértékű paraméter hibát dob (nem csendben 0 lesz)', async () => {
  const client = fakeClient();
  await assert.rejects(() => runCommand(client, 'beep', { ms: 'abc' }), /véges szám/);
  await assert.rejects(() => runCommand(client, 'forward', { cm: 'abc' }), /véges szám/);
  await assert.rejects(() => runCommand(client, 'backward', { cm: 'abc' }), /véges szám/);
  await assert.rejects(() => runCommand(client, 'turn', { degrees: 'abc' }), /véges szám/);
  await assert.rejects(() => runCommand(client, 'ledSingle', { color: 'red', index: 'x' }), /véges szám/);
  assert.deepEqual(client.calls, [], 'egyetlen parancs se indult el');
});

test('a hiányzó nyugta hibát dob (a felületen nem "OK" jelenik meg)', async () => {
  const client = fakeClient();
  client.beep = async () => null; // a robot nem válaszolt
  await assert.rejects(() => runCommand(client, 'beep', { ms: 500 }), /nem nyugtázta/);

  const led = fakeClient();
  led.ledAll = async () => null;
  await assert.rejects(() => runCommand(led, 'led', { color: 'red' }), /nem nyugtázta/);

  const move = fakeClient();
  move.driveDistance = async () => null;
  await assert.rejects(() => runCommand(move, 'forward', { cm: 10 }), /nem nyugtázta/);
});

test('a hiányzó érzékelő-válasz hibát dob', async () => {
  const client = fakeClient();
  client.sonar = async () => null;
  await assert.rejects(() => runCommand(client, 'sonar', {}), /nem válaszolt/);

  const battery = fakeClient();
  battery.battery = async () => null;
  await assert.rejects(() => runCommand(battery, 'battery', {}), /nem válaszolt/);
});

test('a részleges státusz nem hiba, de az üres státusz az', async () => {
  const partial = fakeClient();
  partial.status = async () => ({ batteryPct: 88, sonarMm: null, lightRaw: null, line: null });
  const result = await runCommand(partial, 'status', {});
  assert.equal(result.status.batteryPct, 88);

  const empty = fakeClient();
  empty.status = async () => ({ batteryPct: null, sonarMm: null, lightRaw: null, line: null });
  await assert.rejects(() => runCommand(empty, 'status', {}), /egyetlen érzékelő/);
});

test('a morse és a tune nem vár nyugtára (fire-and-forget)', async () => {
  const client = fakeClient();
  client.playMorse = async (...args) => {
    client.calls.push(['playMorse', ...args]);
    return undefined;
  };
  client.playTune = async (...args) => {
    client.calls.push(['playTune', ...args]);
    return undefined;
  };
  await runCommand(client, 'morse', { text: 'SOS' });
  await runCommand(client, 'tune', { name: 'shave_haircut' });
  assert.deepEqual(client.calls, [
    ['playMorse', 'SOS', 120],
    ['playTune', 'shave_haircut'],
  ]);
});
