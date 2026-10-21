/**
 * No-routing CodieClient tesztek a hamis robottal.
 *
 * A hamis robot a valódi, routing NÉLKÜLI generáció viselkedését emulálja
 * (élőben mérve 2026-10-20):
 *   - GATT: service `d46e7e53-…` + 4 karakterisztika (request/action + reply-párjaik),
 *     a UUID-k kisbetűs, kötőjel nélküli alakban (ahogy a noble/BlueZ adja);
 *   - kérés : SEQ(2 LE) | CMD(2 LE) | PARAM...
 *   - válasz: SEQ(2 LE) | VALUE(változó hosszúságú, LE) — akku 1, távolság/fény/hang 2,
 *     vonal 4 bájt, parancs-nyugta 1 bájt (0x00);
 *   - a firmware connect után eldobja az első frame-et, és a még folyamatban lévő
 *     kérésre érkező frame-et is.
 *
 * A tesztek a fenti, élőben mért viselkedést ellenőrzik.
 */

'use strict';

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { CodieClient } from '../src/ble/client.js';
import {
  FakeNoRoutingCodie,
  FakeNoRoutingNoble,
  FakeNoRoutingScanner,
  nextTick,
} from './fake-robot-norrouting.js';
import * as np from '../src/ble/protocol-norrouting.js';

/** Az élő roboton mért érzékelő-értékek (2026-10-20). */
const LIVE = {
  battery: 97, // 1 bájt
  distanceRaw: 1232, // 2 bájt -> 123 mm
  lightRaw: 4002, // 2 bájt (12 bit)
  soundRaw: 69, // 2 bájt
  lineRaw: 93325135, // 4 bájt
};

/** A firmware SET_COLOR-skálája: hue = floor((h/255)*360*0.7), sat/val = floor((x/255)*100*2.55). */
const LED_RED_EXACT = [0, 255, 255];

function makeClient(robot, options = {}) {
  return new CodieClient({
    address: robot.address,
    noble: new FakeNoRoutingNoble([robot]),
    scanner: new FakeNoRoutingScanner([robot]),
    timeout: 2000,
    scanWindow: 1000,
    connectRetries: 1,
    retryDelay: 10,
    responseTimeout: 500,
    ...options,
  });
}

describe('No-routing CodieClient', () => {
  let client;
  let robot;

  beforeEach(async () => {
    robot = new FakeNoRoutingCodie();
    client = makeClient(robot);
    await client.connect();
  });

  afterEach(async () => {
    if (client && client.isConnected) {
      await client.disconnect();
    }
  });

  // --- a generáció felismerése ----------------------------------------

  test('a kliens felismeri a routing nélküli generációt a GATT-elrendezésből', () => {
    assert.equal(client.variant, 'no-routing');
  });

  test('a robot a valós UUID-kat hirdeti (kisbetűs, kötőjel nélkül)', () => {
    assert.deepEqual(robot.characteristicUuids, [
      '25ad752e7a424c90852690e85fb3741d', // REQUEST
      '02a92ec60e7e415ca311828a802c61d5', // REQUEST_REPLY
      '0b08f48da33f4a93ad2584928e2ef792', // ACTION
      '8a7f8f018679400cb32b464c71f5d06b', // ACTION_REPLY
    ]);
  });

  // --- a setup (echo + warmup) -----------------------------------------

  test('a beállítás ECHO-t küld (seq 1), majd egy akku-lekérdezést (seq 2)', () => {
    const echo = robot.receivedActions[0];
    assert.ok(echo, 'a beállításnak ECHO-t kell küldenie');
    assert.equal(echo.cmd, np.CMD_ECHO);
    assert.equal(echo.seq, 1);

    const warmup = robot.receivedRequests[0];
    assert.ok(warmup, 'a beállításnak warmup-lekérdezést kell küldenie');
    assert.equal(warmup.cmd, np.QUERY_BATTERY);
    assert.equal(warmup.seq, 2);
  });

  test('a firmware eldobja a connect utáni első frame-et (az ECHO-ra nincs válasz)', () => {
    const dropped = robot.droppedFrames[0];
    assert.ok(dropped, 'az első frame-nek el kell esnie');
    assert.equal(dropped.reason, 'first-frame');
    assert.equal(dropped.kind, 'action');
    assert.equal(dropped.seq, 1);
    // az ECHO-ra nem jött válasz
    assert.equal(robot.sentReplies.filter((r) => r.kind === 'action' && r.seq === 1).length, 0);
  });

  test('az első valódi lekérdezés sorszáma 3 (echo=1, warmup=2)', async () => {
    await client.battery();
    const last = robot.receivedRequests.at(-1);
    assert.equal(last.cmd, np.QUERY_BATTERY);
    assert.equal(last.seq, 3);
  });

  // --- érzékelők -------------------------------------------------------

  test('battery() a nyers százalékot adja (97)', async () => {
    assert.equal(await client.battery(), LIVE.battery);
  });

  test('sonar() milliméterben ad (raw 1232 -> 123 mm)', async () => {
    assert.equal(await client.sonar(), Math.round(LIVE.distanceRaw / 10));
  });

  test('light() a nyers 12 bites értéket adja (4002), nem százalékot', async () => {
    const value = await client.light();
    assert.equal(value, LIVE.lightRaw);
    // nem százalék: a nyers érték 4002, a "százalékos" alak 4002/4096*100 ~ 98
    assert.notEqual(value, Math.round((LIVE.lightRaw / 4096) * 100));
  });

  test('mic() a nyers értéket adja (69), nem osztja 20-zal', async () => {
    const value = await client.mic();
    assert.equal(value, LIVE.soundRaw);
    assert.notEqual(value, Math.round(LIVE.soundRaw / 20));
  });

  test('line() egyetlen fix-pontos értéket ad (a codiejs 2^20-as skálája)', async () => {
    const line = await client.line();
    assert.equal(line.value, LIVE.lineRaw);
    // 93325135 / 1048576 = 89.0 — a codiejs így normalizál (lineThreshold: 30)
    assert.equal(line.level, 89);
    assert.equal(line.onLine, true);
  });

  test('a válaszok szélessége a firmware szerint változik (1 / 2 / 2 / 2 / 4 bájt)', async () => {
    await client.battery();
    await client.sonar();
    await client.light();
    await client.mic();
    await client.line();
    const widths = robot.sentReplies
      .filter((r) => r.kind === 'request')
      .slice(-5)
      .map((r) => r.raw.length - 2); // a SEQ(2) a prefix
    assert.deepEqual(widths, [1, 2, 2, 2, 4]);
  });

  test('a válasz a kérés sorszámát vissza echoesolja', async () => {
    await client.battery();
    const request = robot.receivedRequests.at(-1);
    const reply = robot.sentReplies.filter((r) => r.kind === 'request').at(-1);
    assert.equal(reply.seq, request.seq);
  });

  // --- aktuátorok ------------------------------------------------------

  test('a parancs-nyugta 1 bájt (0x00) a ACTION_REPLY csatornán', async () => {
    await client.beep(100);
    const reply = robot.sentReplies.filter((r) => r.kind === 'action').at(-1);
    assert.ok(reply, 'a parancsra nyugta kell jönnie');
    assert.equal(reply.raw.length - 2, 1);
    assert.equal(reply.value, 0);
  });

  test('ledAll("red") a firmware szerinti skálával küldi a SET_COLOR parancsot', async () => {
    await client.ledAll('red');
    const last = robot.receivedActions.at(-1);
    assert.ok(last, 'a LED-parancsnak el kell érnie a robotot');
    assert.equal(last.cmd, np.CMD_SET_COLOR);
    assert.equal(last.params.length, 3);
    // hue: floor((0/255)*360*0.7) = 0
    // sat/val: round((255/255)*100*2.55) = 255 — pontosan (a 100*2.55 float-értéke
    // 254,99999999999997, ezért itt kerekíteni kell, nem levágni)
    assert.deepEqual([...last.params], LED_RED_EXACT);
  });

  test('ledsOff() SET_COLOR [0,0,0]-at küld', async () => {
    await client.ledsOff();
    const last = robot.receivedActions.at(-1);
    assert.equal(last.cmd, np.CMD_SET_COLOR);
    assert.deepEqual(last.params, Buffer.from([0, 0, 0]));
  });

  test('ledAnimation() a SET_ANIMATION parancsot küldi (animáció, hue, sat, repeat, speed)', async () => {
    // a codiejs referencia: setAnimation(animation, hue, saturation, repeat, speed),
    // az animáció sorszáma 0 vagy 1
    await client.ledAnimation(1, { color: 'red', repeat: 3, speed: 20 });
    const last = robot.receivedActions.at(-1);
    assert.ok(last, 'az animáció-parancsnak el kell érnie a robotot');
    assert.equal(last.cmd, np.CMD_SET_ANIMATION);
    // a szín ugyanaz a skála, mint a SET_COLOR-nál (hue 0, sat 255 a pirosnál)
    assert.deepEqual([...last.params], [1, 0, 255, 3, 20]);
  });

  test('a beépített animációt a firmware nyugtázza', async () => {
    const reply = await client.ledAnimation(0, { color: 'blue' });
    assert.ok(reply, 'a nyugta meg kell érkezzen');
    assert.notEqual(reply, null);
  });

  test('beep(500) a volume, frekvencia és időtartam bájtjait küldi (u16 LE)', async () => {
    await client.beep(500);
    const last = robot.receivedActions.at(-1);
    assert.ok(last, 'a csipogásnak el kell érnie a robotot');
    assert.equal(last.cmd, np.CMD_BEEP);
    // volume(1) + frequency(u16 LE) + duration(u16 LE)
    // volume = 100 (0x64), frequency = 2483 Hz (0x09B3 -> B3 09), duration = 500 (0x01F4 -> F4 01)
    assert.deepEqual(last.params, Buffer.from([100, 0xb3, 0x09, 0xf4, 0x01]));
    assert.deepEqual(robot.lastBeep, { volume: 100, frequency: 2483, durationMs: 500 });
  });

  test('driveDistance(1000, 50, 60) MOVE: u16 LE távolság + két sebesség-bájt', async () => {
    await client.driveDistance(1000, 50, 60);
    const last = robot.receivedActions.at(-1);
    assert.ok(last, 'a mozgás-parancsnak el kell érnie a robotot');
    assert.equal(last.cmd, np.CMD_MOVE);
    // distance(u16 LE) + left(i8) + right(i8) — 1000 = 0x03E8 -> E8 03
    assert.deepEqual(last.params, Buffer.from([0xe8, 0x03, 50, 60]));
    assert.deepEqual(robot.lastMove, { distanceMm: 1000, left: 50, right: 60 });
  });

  test('stop() MOTOR_BOTH 0,0-at küld', async () => {
    await client.stop();
    const last = robot.receivedActions.at(-1);
    assert.equal(last.cmd, np.CMD_MOTOR_BOTH);
    assert.deepEqual(last.params, Buffer.from([0, 0]));
  });

  test('driveSpeed(-20, 30) MOTOR_BOTH két komplemens bájtot küld', async () => {
    await client.driveSpeed(-20, 30);
    const last = robot.receivedActions.at(-1);
    assert.equal(last.cmd, np.CMD_MOTOR_BOTH);
    // -20 = 0xEC, 30 = 0x1E
    assert.deepEqual(last.params, Buffer.from([0xec, 0x1e]));
  });

  test('a negatív sebesség i8-ként (két\'s komplemens) megy ki', async () => {
    // a codiejs referencia is így küldi (Utils.getBytes = value & 0xff), és a
    // firmware a bájtot előjelesen értelmezi (a turn: pozitív speed = balra)
    await client.driveSpeed(-40, -40);
    const last = robot.receivedActions.at(-1);
    assert.deepEqual([...last.params], [0xd8, 0xd8]); // -40 = 0xD8
    await client.driveDistance(100, -40, -40);
    const move = robot.receivedActions.at(-1);
    assert.deepEqual([...move.params], [0x64, 0x00, 0xd8, 0xd8]);
  });

  test('driveTurn(90, 25) TURN: u16 szög + i8 sebesség', async () => {
    await client.driveTurn(90, 25);
    const last = robot.receivedActions.at(-1);
    assert.equal(last.cmd, np.CMD_TURN);
    // 90 = 0x005A -> 5A 00, speed = 25
    assert.deepEqual(last.params, Buffer.from([0x5a, 0x00, 25]));
  });

  // --- összesített állapot --------------------------------------------

  test('status() az összes érzékelőt egy csomagban adja', async () => {
    const status = await client.status();
    assert.equal(status.batteryPct, LIVE.battery);
    assert.equal(status.sonarMm, 123);
    assert.equal(status.lightRaw, LIVE.lightRaw);
    assert.equal(status.line.value, LIVE.lineRaw);
    assert.equal(status.line.level, 89);
  });

  test('a lekérések és az akciók egy közös sorszám-számlálót használnak', async () => {
    await client.battery(); // query: seq 3
    await client.beep(100); // action: seq 4
    await client.sonar(); // query: seq 5
    assert.equal(robot.receivedRequests.at(-1).seq, 5);
    assert.equal(robot.receivedActions.at(-1).seq, 4);
  });

  // --- a routingos generációhoz nem tartozó parancsok -------------------

  test('batteryVoltage() null a routing nélküli generáción', async () => {
    assert.equal(await client.batteryVoltage(), null);
  });

  test('appConnected/appDisconnected null a routing nélküli generáción', async () => {
    assert.equal(await client.appConnected(), null);
    assert.equal(await client.appDisconnected(), null);
  });
});

describe('No-routing firmware-quirkök', () => {
  test('a firmware eldobja a connect utáni első frame-et (nincs válasz)', async () => {
    const robot = new FakeNoRoutingCodie();
    await robot.requestChar.writeAsync(np.buildFrame(np.QUERY_BATTERY, [], 1));
    await nextTick();
    assert.equal(robot.sentReplies.length, 0, 'az első frame-re nem jön válasz');
    assert.equal(robot.droppedFrames.length, 1);
    assert.equal(robot.droppedFrames[0].reason, 'first-frame');
  });

  test('a fedésben érkező kérést a firmware eldobja (nincs válasz)', async () => {
    const robot = new FakeNoRoutingCodie();
    // az első frame eleve eldobódik
    await robot.requestChar.writeAsync(np.buildFrame(np.QUERY_BATTERY, [], 1));
    // a második megválaszolódik...
    await robot.requestChar.writeAsync(np.buildFrame(np.QUERY_BATTERY, [], 2));
    // ...de a harmadik még repülő válasz közben érkezik -> eldobódik
    await robot.requestChar.writeAsync(np.buildFrame(np.QUERY_BATTERY, [], 3));
    await nextTick();
    assert.equal(robot.sentReplies.length, 1);
    assert.equal(robot.sentReplies[0].seq, 2);
    assert.deepEqual(
      robot.droppedFrames.map((f) => f.reason),
      ['first-frame', 'overlap'],
    );
  });

  test('a kliens a beállítás után az első valódi kérésre már választ kap', async () => {
    const robot = new FakeNoRoutingCodie();
    const client = makeClient(robot);
    await client.connect();
    assert.equal(await client.battery(), LIVE.battery);
    await client.disconnect();
  });

  test('a kliens sorban küldi a lekéréseket, ezért egyik sem esik fedésbe', async () => {
    const robot = new FakeNoRoutingCodie();
    const client = makeClient(robot);
    await client.connect();
    // a status() négy érzékelőt KÖZEL egymás után kér — a sornak meg kell
    // őriznie, hogy egyik kérés se érkezzen repülő válasz közben
    await client.status();
    const overlapped = robot.droppedFrames.filter((f) => f.reason === 'overlap');
    assert.deepEqual(overlapped, [], 'egyik kérés sem eshet fedésbe');
    await client.disconnect();
  });

  test('a reply-karakterisztika olvasható tartalékként (indicate nélkül is)', async () => {
    const robot = new FakeNoRoutingCodie();
    const client = makeClient(robot);
    await client.connect();
    // kikapcsoljuk az indicate-et: a kliens csak a readAsync visszaolvasással
    // tudja megszerezni az értéket (a válasz timeoutol, majd fallback)
    robot.subRequestReply = false;
    assert.equal(await client.battery(), LIVE.battery);
    await client.disconnect();
  });
});

describe('No-routing hibakezelés', () => {
  test('connect előtt a műveletek hibát dobnak', async () => {
    const robot = new FakeNoRoutingCodie();
    const client = makeClient(robot);
    await assert.rejects(client.battery(), /Nincs kapcsolat/);
    await assert.rejects(client.beep(100), /Nincs kapcsolat/);
    await assert.rejects(client.ledAll('red'), /Nincs kapcsolat/);
  });
});
