/** A wire-protokoll unit tesztje (a Python `tests/test_protocol.py` tükörképe). */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as p from '../src/ble/protocol.js';

test('INFO bájt', () => {
  assert.equal(p.infoByte(p.ROLE_APP, p.ROLE_MCU, p.PRIO_NORMAL), 0x40);
  assert.equal(p.infoByte(p.ROLE_APP, p.ROLE_MCU, p.PRIO_HIGH), 0x48);
});

test('beep frame a 2026-07-07-én élőben igazolt bájtok', () => {
  p.resetSeq();
  const { frame, seq } = p.buildFrame(p.CMD_SPEAK_BEEP, p.beepArgs(1000));
  assert.equal(seq, 1);
  assert.equal(frame.toString('hex'), '40010064100200e803');
});

test('a szenzorkérés argumentum-hossza nulla', () => {
  const { frame } = p.buildFrame(p.CMD_BATTERY);
  assert.equal(frame.length, 7);
  assert.equal(frame.readUInt16LE(5), 0);
});

test('a szekvencia nő és 0xFFFF-nél visszafordul', () => {
  p.resetSeq();
  assert.equal(p.buildFrame(p.CMD_MIC).seq, 1);
  assert.equal(p.buildFrame(p.CMD_MIC).seq, 2);
  for (let i = 0; i < 0xffff - 2; i += 1) p.nextSeq();
  assert.equal(p.nextSeq(), 1);
});

test('az argumentumhossz tükrözi az argumentumokat', () => {
  const { frame } = p.buildFrame(p.CMD_DRIVE_DISTANCE, p.driveDistanceArgs(100, 30, 30));
  assert.equal(frame.readUInt16LE(5), 4);
  assert.equal(frame.subarray(7).toString('hex'), '64001e1e');
});

test('a negatív i8 két komplemens', () => {
  assert.equal(p.i8(-1).toString('hex'), 'ff');
  assert.equal(p.i8(30).toString('hex'), '1e');
});

test('a "mind a 12 LED" maszk 0x0FFF', () => {
  assert.equal(p.ledAllArgs('green').subarray(0, 2).toString('hex'), 'ff0f');
});

test('az egyedi LED maszkja az indexből jön', () => {
  assert.equal(p.ledSingleArgs('red', 1).subarray(0, 2).toString('hex'), '0100');
  assert.equal(p.ledSingleArgs('red', 12).subarray(0, 2).toString('hex'), '0008');
  // az index lefogva 1..12
  assert.equal(p.ledSingleArgs('red', 0).subarray(0, 2).toString('hex'), '0100');
  assert.equal(p.ledSingleArgs('red', 99).subarray(0, 2).toString('hex'), '0008');
});

test('a szín HSV 0-255 skálán (nem 0-100)', () => {
  assert.deepEqual(p.colorHsv('red'), [0, 255, 255]);
  assert.deepEqual(p.colorHsv('green'), [85, 255, 255]);
  assert.deepEqual(p.colorHsv('blue'), [170, 255, 255]);
  assert.deepEqual(p.colorHsv('white'), [0, 0, 255]);
});

test('ismeretlen szín hibát dob', () => {
  assert.throws(() => p.colorHsv('mauve'), /Ismeretlen szín/);
});

test('a válasz dekódolása', () => {
  const resp = p.decodeResponse(Buffer.from([0x10, 0x2a, 0x00, 0x69, 0x10, 0x01, 0x00, 0x07, 0x00, 0x5a]));
  assert.equal(resp.seq, 42);
  assert.equal(resp.cmd, p.CMD_BATTERY);
  assert.equal(resp.arglen, 1);
  assert.equal(resp.reqSeq, 7);
  assert.equal(resp.args[0], 0x5a);
});

test('a túl rövid válasz null', () => {
  assert.equal(p.decodeResponse(Buffer.from([0x10, 0x00])), null);
});

test('a beep időtartalma 10000 ms-ra van vágva', () => {
  assert.equal(p.beepArgs(99999).toString('hex'), '1027');
  assert.equal(p.beepArgs(-5).toString('hex'), '0000');
});

test('a kanonikus UUID-forma összeveti a kötőjeles és a rövid alakot', () => {
  assert.equal(
    p.canonicalUuid('52AF0002-978A-628D-C845-0A104CA2B8DD'),
    '52af0002978a628dc8450a104ca2b8dd',
  );
  assert.equal(p.canonicalUuid('0002'), p.canonicalUuid('00000002-0000-1000-8000-00805f9b34fb'));
  assert.ok(p.sameUuid(p.WRITE_UUID, '52af0002978a628dc8450a104ca2b8dd'));
  assert.ok(p.sameUuid(p.NOTIFY_UUID, '52AF0003-978A-628D-C845-0A104CA2B8DD'));
  assert.equal(p.sameUuid(p.WRITE_UUID, p.NOTIFY_UUID), false);
});
