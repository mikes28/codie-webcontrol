/** A magas szintű parancsok szemantikája (a REST, a CLI és a konzol közös rétege). */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runCommand } from '../src/commands.js';

function fakeClient() {
  const calls = [];
  const record = (name) => async (...args) => {
    calls.push([name, ...args]);
    return null;
  };
  return {
    calls,
    beep: record('beep'),
    ledAll: record('ledAll'),
    ledSingle: record('ledSingle'),
    ledsOff: record('ledsOff'),
    playMorse: record('playMorse'),
    playTune: record('playTune'),
    driveDistance: record('driveDistance'),
    driveTurn: record('driveTurn'),
    driveSpeed: record('driveSpeed'),
    // a valódi kliensben a stop() a driveSpeed(0, 0)-at hívja
    stop: async () => {
      calls.push(['driveSpeed', 0, 0]);
      return null;
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
  assert.deepEqual(client.calls, [['playMorse', 'SOS', undefined]]);
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
