/**
 * Paritás: a JS port bájtra bájtra megegyezik a Python referencia-implementációval.
 *
 * A `parity_probe.py` a repo Python `codie/wire.py`, `codie/wire_norrouting.py`,
 * `morse.py` és `tunes.py` moduljait futtatja le, és JSON-ban adja vissza a
 * frame-eket, színeket, Morse-ritmusokat. Ha a python3 nem elérhető, a teszt
 * kimarad (a JS oldali unit tesztek akkor is futnak).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as p from '../src/ble/protocol.js';
import * as np from '../src/ble/protocol-norrouting.js';
import { textToRhythm } from '../src/morse.js';
import { RHYTHMS } from '../src/tunes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const probePath = path.join(here, 'parity_probe.py');

function loadReference() {
  try {
    const stdout = execFileSync('python3', [probePath], { encoding: 'utf8' });
    return JSON.parse(stdout);
  } catch (error) {
    return null;
  }
}

const reference = loadReference();

test('a JS port megegyezik a Python wire-protokollal', { skip: reference ? false : 'python3 hiányzik' }, () => {
  p.resetSeq();
  const frames = [];
  const seqs = {};
  const record = (key, cmdId, args) => {
    const { frame, seq } = p.buildFrame(cmdId, args);
    frames.push(frame.toString('hex'));
    seqs[key] = seq;
  };

  record('beep', p.CMD_SPEAK_BEEP, p.beepArgs(1000));
  record('beep_max', p.CMD_SPEAK_BEEP, p.beepArgs(99999));
  record('battery', p.CMD_BATTERY);
  record('light', p.CMD_LIGHT);
  record('line', p.CMD_LINE);
  record('sonar', p.CMD_SONAR);
  record('mic', p.CMD_MIC);
  record('drive_speed', p.CMD_DRIVE_SPEED, p.driveSpeedArgs(30, -30));
  record('drive_distance', p.CMD_DRIVE_DISTANCE, p.driveDistanceArgs(100, 30, 30));
  record('drive_turn', p.CMD_DRIVE_TURN, p.driveTurnArgs(90, -40));
  record('led_all_red', p.CMD_LED_SET_COLOR, p.ledAllArgs('red'));
  record('led_all_white', p.CMD_LED_SET_COLOR, p.ledAllArgs('white'));
  record('led_single_3', p.CMD_LED_SET_COLOR, p.ledSingleArgs('blue', 3));
  record('led_single_12', p.CMD_LED_SET_COLOR, p.ledSingleArgs('orange', 12));
  record('led_single_99', p.CMD_LED_SET_COLOR, p.ledSingleArgs('cyan', 99));
  record('app_connected', p.CMD_APP_CONNECTED);
  record('app_disconnected', p.CMD_APP_DISCONNECTED);

  assert.deepEqual(frames, reference.frames, 'a frame-ek bájtra bájtra egyeznek');
  assert.deepEqual(seqs, reference.seqs, 'a szekvencia-számlálás egyezik');

  const colors = Object.fromEntries(Object.keys(p.COLORS_RGB).map((name) => [name, p.colorHsv(name)]));
  assert.deepEqual(colors, reference.colors, 'a színek HSV értéke egyezik');

  assert.deepEqual(
    [
      p.infoByte(p.ROLE_APP, p.ROLE_MCU, p.PRIO_NORMAL),
      p.infoByte(p.ROLE_APP, p.ROLE_MCU, p.PRIO_HIGH),
      p.infoByte(p.ROLE_BROADCAST, p.ROLE_APP, p.PRIO_NORMAL),
    ],
    reference.infoBytes,
  );

  const decoded = p.decodeResponse(Buffer.from('102a006910010007005a00', 'hex'));
  assert.deepEqual(
    {
      seq: decoded.seq,
      cmd: decoded.cmd,
      arglen: decoded.arglen,
      reqSeq: decoded.reqSeq,
      args: decoded.args.toString('hex'),
    },
    reference.decoded,
    'a válasz dekódolása egyezik',
  );
  assert.equal(p.decodeResponse(Buffer.from([0x10, 0x00])), reference.shortDecode);

  for (const [text, unit] of [['SOS', 120], ['hello world', 100], ['Codie 42', 60]]) {
    assert.deepEqual(textToRhythm(text, unit), reference.morse[text], `Morse: ${text}`);
  }

  const jsTunes = Object.fromEntries(
    Object.entries(RHYTHMS).map(([name, pattern]) => [name, pattern.map(([b, g]) => [b, g])]),
  );
  assert.deepEqual(jsTunes, reference.tunes, 'a beépített ritmusok egyeznek');

  assert.equal(p.RESPONSE_ARG_POS, reference.responseArgPos);
  assert.equal(p.MAX_BEEP_MS, reference.maxBeepMs);
});

test('a routing nélküli JS port is megegyezik a Python wire-protokollal', { skip: reference ? false : 'python3 hiányzik' }, () => {
  const nr = reference.noRouting;

  const frames = [
    np.buildFrame(np.CMD_MOTOR_BOTH, [40, 40], 1).toString('hex'),
    np.buildFrame(np.CMD_MOVE, [...np.u16(300), 30, 30], 2).toString('hex'),
    np.buildFrame(np.CMD_TURN, [...np.u16(90), 40], 3).toString('hex'),
    np.buildFrame(np.CMD_BEEP, [100, ...np.u16(2000), ...np.u16(500)], 4).toString('hex'),
    np.buildFrame(np.CMD_SET_COLOR, [10, 20, 30], 5).toString('hex'),
    np.buildFrame(np.CMD_SET_ANIMATION, [1, 10, 20, 30, 40], 6).toString('hex'),
    np.buildFrame(np.QUERY_BATTERY, [], 7).toString('hex'),
    np.buildFrame(np.QUERY_DISTANCE, [], 8).toString('hex'),
    np.buildFrame(np.QUERY_SOUND, [], 9).toString('hex'),
    np.buildFrame(np.QUERY_LIGHT, [], 10).toString('hex'),
    np.buildFrame(np.QUERY_LINE, [], 11).toString('hex'),
  ];
  assert.deepEqual(frames, nr.frames, 'a frame-ek bájtra bájtra egyeznek');

  const replies = [];
  for (const payload of [[0x61], [0x15, 0x00], [0x05, 0x07, 0x00, 0x00]]) {
    const decoded = np.decodeReply(Buffer.from([0x01, 0x00, ...payload]));
    replies.push({
      seq: decoded.seq,
      value: decoded.value,
      payload: decoded.payload.toString('hex'),
    });
  }
  assert.deepEqual(replies, nr.replies, 'a válasz dekódolása egyezik');

  const line = np.decodeLine(Buffer.from([0x05, 0x07, 0x00, 0x00]));
  assert.deepEqual(
    { value: line.value, level: line.level, onLine: line.onLine },
    nr.line,
    'a vonalérték dekódolása egyezik',
  );

  const colors = Object.fromEntries(
    Object.keys(p.COLORS_RGB).map((name) => [name, np.colorParams(name)]),
  );
  assert.deepEqual(colors, nr.colors, 'a színek paraméterei egyeznek');

  assert.deepEqual(
    [np.normalizeDistance(0), np.normalizeDistance(21), np.normalizeDistance(25), np.normalizeDistance(210), np.normalizeDistance(1234)],
    nr.normalized.distance,
    'a távolság normalizálása egyezik',
  );
  assert.deepEqual(
    [np.normalizeBattery(0), np.normalizeBattery(97), np.normalizeBattery(100), np.normalizeBattery(120)],
    nr.normalized.battery,
    'az akku normalizálása egyezik',
  );
});
