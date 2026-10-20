/**
 * Codie BLE wire-protokoll — frame kódolás/dekódolás (JavaScript port).
 *
 * A Python `codie/protocol.py` 1:1 portja: azonos parancs-ID-k, azonos
 * little-endian frame-elrendezés, azonos HSV 0-255 skála. A `test/parity.test.js`
 * összehasonlítja a két implementáció bájtra bájtra, így a port nem csúszhat el.
 *
 * Frame (little-endian, max 20 byte):
 *   INFO(1) | SEQ(2) | CMD(2) | ARGLEN(2) | ARGDAT...
 * A válaszframe-ben a REQSEQ(2) a CMD és ARGLEN után jön, ezért az argumentumok
 * a 9. bájttól kezdődnek.
 */

'use strict';

// --- BLE GATT azonosítók -------------------------------------------------

export const SERVICE_UUID = '52af0001-978a-628d-c845-0a104ca2b8dd';
export const WRITE_UUID = '52af0002-978a-628d-c845-0a104ca2b8dd';
export const NOTIFY_UUID = '52af0003-978a-628d-c845-0a104ca2b8dd';

/**
 * Kanonikus UUID-forma: kisbetűs, kötőjel nélkül, a Bluetooth rövid formáját
 * is kiterjesztve. A BLE bindingek (noble/BlueZ) a kötőjel nélküli alakot adják
 * vissza, ezért minden összehasonlítást ezen a formán kell végezni.
 */
export function canonicalUuid(uuid) {
  if (!uuid) return '';
  let hex = String(uuid).toLowerCase().replace(/-/g, '');
  if (hex.length === 4) hex = `0000${hex}00001000800000805f9b34fb`;
  else if (hex.length === 8) hex = `${hex}00001000800000805f9b34fb`;
  return hex;
}

/** Két UUID azonos-e (formátumfüggetlenül)? */
export function sameUuid(a, b) {
  return Boolean(a) && Boolean(b) && canonicalUuid(a) === canonicalUuid(b);
}

// --- Szerepek (ordinal) és prioritás -------------------------------------

export const ROLE_APP = 0;
export const ROLE_MCU = 1;
export const ROLE_BLE = 2;
export const ROLE_BROADCAST = 3;

export const PRIO_NORMAL = 0x00;
export const PRIO_HIGH = 0x08;

// --- Parancs-ID-k (CodieCommandType) -------------------------------------

export const CMD_DRIVE_SPEED = 0x1060;      // leftSpeed i8, rightSpeed i8  (%)
export const CMD_DRIVE_DISTANCE = 0x1061;   // distance u16 (mm), leftSpeed i8, rightSpeed i8
export const CMD_DRIVE_TURN = 0x1062;       // degree u16 (°), speed i8  (+ balra, - jobbra)
export const CMD_SONAR = 0x1063;            // (szenzor) -> range u16 (mm)
export const CMD_SPEAK_BEEP = 0x1064;       // duration u16 (ms, max 10000)
export const CMD_LED_SET_COLOR = 0x1065;    // ledMask u16, hue u8, sat u8, val u8  (HSV 0-255!)
export const CMD_LED_START_ANIM = 0x1066;   // beépített animáció
export const CMD_APP_CONNECTED = 0x1067;    // app csatlakozás jelzése az MCU-nak
export const CMD_APP_DISCONNECTED = 0x1068;  // app leválás jelzése
export const CMD_BATTERY = 0x1069;          // (szenzor) -> soc u8 (%)
export const CMD_LIGHT = 0x106a;            // (szenzor) -> u16 (12 bit)
export const CMD_LINE = 0x106b;             // (szenzor) -> left u16, right u16 (12 bit)
export const CMD_MIC = 0x106c;             // (szenzor) -> u16
export const CMD_SWITCH_BOOTLOADER = 0x106d; // VESZÉLYES — bootloaderbe vált, ne használd
export const CMD_BATTERY_VOLTAGE = 0x106e;  // (szenzor) -> u16; ezen a firmware-en nincs válasz

// A válaszcsomagban innen kezdődnek az argumentumok:
// INFO(1)+SEQ(2)+CMD(2)+ARGLEN(2)+REQSEQ(2) = 9
export const RESPONSE_ARG_POS = 9;

export const MAX_BEEP_MS = 10000;

// --- Színek --------------------------------------------------------------
// A hivatalos Codie BLE API (v1.0) szerint a hue/sat/val 0-255 tartományban megy.

export const COLORS_RGB = {
  white: [255, 255, 255],
  green: [0, 255, 0],
  red: [255, 0, 0],
  blue: [0, 0, 255],
  cyan: [0, 255, 255],
  yellow: [255, 255, 0],
  orange: [255, 200, 0],
};

/**
 * Egy szín HSV értéke 0..255 skálán (hivatalos Codie BLE API v1.0).
 * @param {string} name
 * @returns {[number, number, number]} [hue, saturation, value]
 */
export function colorHsv(name) {
  const rgb = COLORS_RGB[name];
  if (!rgb) {
    throw new Error(
      `Ismeretlen szín: ${JSON.stringify(name)}. Választható: ${Object.keys(COLORS_RGB).join(', ')}`,
    );
  }
  const [h, s, v] = rgbToHsv(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
  return [Math.trunc(h * 255), Math.trunc(s * 255), Math.trunc(v * 255)];
}

/** Python `colorsys.rgb_to_hsv` 1:1 portja (r,g,b ∈ [0,1]). */
function rgbToHsv(r, g, b) {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const rangec = maxc - minc;
  const v = maxc;
  if (minc === maxc) return [0, 0, v];
  const s = rangec / maxc;
  const rc = (maxc - r) / rangec;
  const gc = (maxc - g) / rangec;
  const bc = (maxc - b) / rangec;
  let h;
  if (r === maxc) h = bc - gc;
  else if (g === maxc) h = 2.0 + rc - bc;
  else h = 4.0 + gc - rc;
  h = h / 6.0;
  // A Python `%` mindig nem-negatív eredményt ad pozitív osztóval — a JS `%` megtartja
  // a jelet, ezért a negatív hue-t itt kézzel kell "pozitívvá" tenni (Python colorsys).
  if (h < 0) h += 1.0;
  return [h, s, v];
}

// --- Alacsonyszintű bájt-segédek -----------------------------------------

export function u16(value) {
  const v = value & 0xffff;
  return Buffer.from([v & 0xff, (v >> 8) & 0xff]);
}

export function u8(value) {
  return Buffer.from([value & 0xff]);
}

/** Két's komplemens i8 (Python `_i8`: `value & 0xFF`). */
export function i8(value) {
  return Buffer.from([value & 0xff]);
}

/** INFO bájt: (sender<<4) | (dest<<6) | prio. */
export function infoByte(sender = ROLE_APP, dest = ROLE_MCU, prio = PRIO_NORMAL) {
  return ((sender << 4) | (dest << 6) | prio) & 0xff;
}

// --- Szekvencia-számláló -------------------------------------------------

let seqCounter = 0;

export function nextSeq() {
  seqCounter = seqCounter >= 0xffff ? 1 : seqCounter + 1;
  return seqCounter;
}

export function resetSeq() {
  seqCounter = 0;
}

// --- Frame összeállítás --------------------------------------------------

/**
 * Összeállít egy kérés-frame-et.
 * @returns {{frame: Buffer, seq: number}}
 */
export function buildFrame(
  cmdId,
  args = Buffer.alloc(0),
  seq = null,
  sender = ROLE_APP,
  dest = ROLE_MCU,
  prio = PRIO_NORMAL,
) {
  const useSeq = seq === null || seq === undefined ? nextSeq() : seq;
  const body = Buffer.isBuffer(args) ? args : Buffer.from(args);
  const arglen = body.length;
  const header = Buffer.from([
    infoByte(sender, dest, prio),
    useSeq & 0xff,
    (useSeq >> 8) & 0xff,
    cmdId & 0xff,
    (cmdId >> 8) & 0xff,
    arglen & 0xff,
    (arglen >> 8) & 0xff,
  ]);
  return { frame: Buffer.concat([header, body]), seq: useSeq };
}

// --- Argumentum-építők parancsonként -------------------------------------

export function beepArgs(durationMs) {
  return u16(Math.max(0, Math.min(durationMs, MAX_BEEP_MS)));
}

/** Mind a 12 LED egy színre (ledMask = 0x0FFF). */
export function ledAllArgs(color) {
  const [h, s, v] = colorHsv(color);
  return Buffer.concat([u16(0x0fff), u8(h), u8(s), u8(v)]);
}

/** Egyetlen LED (index 1..12) beállítása. */
export function ledSingleArgs(color, index) {
  const i = Math.max(1, Math.min(index, 12));
  const mask = 1 << (i - 1);
  const [h, s, v] = colorHsv(color);
  return Buffer.concat([u16(mask), u8(h), u8(s), u8(v)]);
}

export function driveSpeedArgs(left, right) {
  return Buffer.concat([i8(left), i8(right)]);
}

export function driveDistanceArgs(distanceMm, left, right) {
  return Buffer.concat([u16(distanceMm), i8(left), i8(right)]);
}

export function driveTurnArgs(degree, speed) {
  return Buffer.concat([u16(degree), i8(speed)]);
}

// --- Válasz dekódolás ----------------------------------------------------

/**
 * A notify-csatornán érkező válasz értelmezése.
 * A válasz CMD felső bájtja 0x80-nal jelölt (MCU->APP); a REQSEQ a kérésünk
 * SEQ-jét tükrözi, ezzel párosítható a válasz.
 * @returns {{seq: number, cmd: number, arglen: number, reqSeq: number, args: Buffer} | null}
 */
export function decodeResponse(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < RESPONSE_ARG_POS) return null;
  const seq = buf[1] | (buf[2] << 8);
  const cmd = (buf[3] | (buf[4] << 8)) & 0x7fff; // MSB levágva
  const arglen = buf[5] | (buf[6] << 8);
  const reqSeq = buf[7] | (buf[8] << 8);
  return { seq, cmd, arglen, reqSeq, args: buf.subarray(RESPONSE_ARG_POS) };
}

export function readU16(args, offset) {
  const buf = Buffer.isBuffer(args) ? args : Buffer.from(args);
  if (buf.length < offset + 2) return null;
  return buf[offset] | (buf[offset + 1] << 8);
}

export function readU8(args, offset) {
  const buf = Buffer.isBuffer(args) ? args : Buffer.from(args);
  if (buf.length < offset + 1) return null;
  return buf[offset];
}
