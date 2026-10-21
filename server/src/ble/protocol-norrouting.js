/**
 * Codie BLE wire-protokoll — **routing nélküli** generáció (JS port).
 *
 * A repo Python `codie/protocol.py` a routingos generációt beszélí (INFO|SEQ|CMD|
 * ARGLEN frame, `52af0001/2/3` UUID-k). Ez a modul a **másik** Codie-generáció
 * protokollja, amit a [zbettenbuk/codiejs](https://github.com/zbettenbuk/codiejs)
 * projekt dokumentál ("robots that don't use the routing parameter").
 *
 * Különbségek:
 *   - nincs routing/INFO bájt: a frame `SEQ(2) | CMD(2) | PARAM...`;
 *   - a CMD egy u16 (a magas bájt 0);
 *   - két író és két válasz-karakterisztika van (action/request + reply);
 *   - a érzékelő-válasz: `SEQ(2) | VALUE(változó hosszúságú LE)`.
 *
 * A két generáció ugyanazokat a képességeket kínálja (mozgás, LED, hang,
 * érzékelők), csak a frame-formátum és a skálák térnek el — a kliensréteg
 * ezt elrejti a parancsréteg elől.
 */

'use strict';

// --- BLE GATT azonosítók (a codiejs konfigurációja alapján) ---------------

export const SERVICE_UUID = 'd46e7e53-ba2f-4044-ade9-f85ead45f458';
/** Ide írunk az érzékelő-kérést; a válasz itt jön (indicate). */
export const REQUEST_UUID = '25ad752e7a424c90852690e85fb3741d';
export const REQUEST_REPLY_UUID = '02a92ec60e7e415ca311828a802c61d5';
/** Ide írunk a parancsot (beep, LED, motor); a válasz itt jön (indicate). */
export const ACTION_UUID = '0b08f48da33f4a93ad2584928e2ef792';
export const ACTION_REPLY_UUID = '8a7f8f018679400cb32b464c71f5d06b';

// --- Parancs-ID-k ---------------------------------------------------------

export const CMD_ECHO = 0x00;
export const CMD_MOVE = 0x01; // distance u16 (mm), leftSpeed i8, rightSpeed i8
export const CMD_MOTOR_BOTH = 0x02; // leftSpeed i8, rightSpeed i8
export const CMD_MOTOR_LEFT = 0x03; // speed i8
export const CMD_MOTOR_RIGHT = 0x04; // speed i8
export const CMD_TURN = 0x05; // angle u16 (°), speed i8
export const CMD_BEEP = 0x06; // volume u8, frequency u16 (Hz), duration u16 (ms)
export const CMD_SET_COLOR = 0x08; // hue u8, saturation u8, value u8
export const CMD_SET_ANIMATION = 0x09; // animation u8, hue u8, sat u8, repeat u8, speed u8

// A motorsebesség **előjeles** (i8, két's komplemens): a codiejs referencia is
// így küldi (`Utils.getBytes` = `value & 0xff`), és a `turn` dokumentáltan
// "pozitív speed = balra" — vagyis a firmware a bájtot i8-ként értelmezi.
// (A 0..100 a pozitív sebesség tartománya; a negatív a visszafelé.)

// --- Érzékelő-kérdések (a request karakterisztikára) ----------------------

export const QUERY_DISTANCE = 0x01; // -> mm
export const QUERY_BATTERY = 0x02; // -> %
export const QUERY_SOUND = 0x03; // -> raw (0..~2048)
export const QUERY_LIGHT = 0x04; // -> raw (0..4096)
export const QUERY_LINE = 0x05; // -> raw

export const MAX_BEEP_MS = 10000;

// --- Frame kódolás --------------------------------------------------------

/** u16 little-endian bájtok. */
export function u16(value) {
  const v = value & 0xffff;
  return [v & 0xff, (v >> 8) & 0xff];
}

/**
 * Parancs-frame: SEQ(2) | CMD(2) | PARAM...
 * @param {number} cmd u16 parancs-ID
 * @param {number[]} params paraméter-bájtok
 * @param {number} seq sorszám
 */
export function buildFrame(cmd, params = [], seq = 0) {
  return Buffer.from([...u16(seq), ...u16(cmd), ...params]);
}

/**
 * Válasz-frame dekódolása.
 *
 * A valós robot válasza: `SEQ(2 LE) | VALUE(változó hosszúságú, LE)`.
 * Élőben mért hosszak: akku 1 bájt, távolság/fény/hang 2 bájt, vonal 4 bájt,
 * parancs-nyugta 1 bájt (0x00). A VALUE ezért a maradék bájtok little-endian
 * száma — nem fix szélességű.
 *
 * @returns {{seq: number, value: number, payload: Buffer}|null}
 */
export function decodeReply(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 3) return null;
  const seq = buf[0] | (buf[1] << 8);
  const payload = buf.subarray(2);
  let value = 0;
  for (let i = payload.length - 1; i >= 0; i -= 1) {
    value = value * 256 + payload[i];
  }
  return { seq, value, payload };
}

// --- Érzékelő-értékek normalizálása (a codiejs alapján) -------------------

/** Távolság: a nyers érték 0,1 mm egységben érkezik. */
export function normalizeDistance(raw) {
  return Math.round(raw / 10);
}

/** Akku: százalék, 100-ra vágva. */
export function normalizeBattery(raw) {
  return raw > 100 ? 100 : raw;
}

// --- A vonal-érzékelő értéke ----------------------------------------------

/**
 * A routing nélküli generációban a vonal-érzékelő **nem** két 12 bites értéket
 * ad (mint a routingos generáció `LineGetRaw` parancsa), hanem egyetlen
 * 32 bites, fix-pontos számot.
 *
 * Élőben mérve (2026-10-20, 60 minta): a bájtminta mindig `0x05xx07yy` volt —
 * a felső és a második bájt állandó, csak a legalsó és a harmadik bájt mozog.
 * Ez egyetlen fix-pontos értéket jelent, nem két független érzékelőt.
 *
 * A codiejs referencia (`lib/codie.js` + `lib/config.json`) ezt 2^20-zal osztja
 * (`lineThreshold: 30` a küszöb) — ezt a normalizálást követjük.
 */
export const LINE_SCALE = 1024 * 1024;
export const LINE_THRESHOLD = 30;

/**
 * A vonal-érzékelő 4 bájtos értékének dekódolása.
 * @param {Buffer|Uint8Array} payload a válasz payloadja (a SEQ nélkül)
 * @returns {{value: number, level: number, onLine: boolean}}
 */
export function decodeLine(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  const value = buf.length >= 4 ? buf.readUInt32LE(0) : 0;
  const level = Math.round((value / LINE_SCALE) * 100) / 100;
  return { value, level, onLine: level > LINE_THRESHOLD };
}
