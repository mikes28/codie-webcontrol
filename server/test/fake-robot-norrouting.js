/**
 * Hamis Codie robot — a routing NÉLKÜLI generáció GATT-felületének emulációja.
 *
 * A wire-protokoll (élőben mérve 2026-10-20, valódi BLE robot):
 *
 *   service        d46e7e53-ba2f-4044-ade9-f85ead45f458
 *   REQUEST        25ad752e7a424c90852690e85fb3741d  (write)           — érzékelő-kérés
 *   REQUEST_REPLY  02a92ec60e7e415ca311828a802c61d5  (read+indicate)  — érzékelő-válasz
 *   ACTION         0b08f48da33f4a93ad2584928e2ef792  (write)           — beep / LED / motor
 *   ACTION_REPLY   8a7f8f018679400cb32b464c71f5d06b  (indicate)       — parancs-nyugta
 *
 *   kérés : SEQ(2 LE) | CMD(2 LE) | PARAM...
 *   válasz: SEQ(2 LE) | VALUE(változó hosszúságú, LE)
 *           akku 1 bájt · távolság/fény/hang 2 bájt · vonal 4 bájt · nyugta 1 bájt (0x00)
 *
 * A firmware két furcsasága (élőben mérve):
 *
 *   1. connect után az első frame-et eldobja — NEM jön rá válasz. Ezért a kliens
 *      a beállításkor ECHO-t küld az action csatornán: az "égeti el" az első
 *      eldobást, így az első értékes kérés (a warmup) már választ kap.
 *   2. Ha egy kérés még folyamatban van, az utána érkező frame szintén eldobódik
 *      (nincs válasz). Ezért a kliens a lekéréseket és az akciókat külön sorban
 *      küldi, és csak a beérkező válasz után indítja a következőt.
 *
 * A hamis robot ugyanazt a viselkedést adja: eldobja az első frame-et és a
 * fedésben érkező frame-eket, a többi kérésre pedig a mért szélességű választ
 * küldi a megfelelő reply-karakterisztikán (indicate).
 */

'use strict';

import { EventEmitter } from 'node:events';
import * as np from '../src/ble/protocol-norrouting.js';

/** Kanonikus UUID: kisbetűs, kötőjel nélkül (ahogy a noble/BlueZ adja vissza). */
function canonicalUuid(uuid) {
  return String(uuid).replace(/-/g, '').toLowerCase();
}

/** u16 little-endian bájtok. */
function u16le(value) {
  const v = value & 0xffff;
  return Buffer.from([v & 0xff, (v >> 8) & 0xff]);
}

/** u32 little-endian bájtok. */
function u32le(value) {
  const v = value >>> 0;
  return Buffer.from([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

/** i8 két's komplemens bájtként (255 feletti érték is átmegy). */
function i8(value) {
  return value & 0xff;
}

/** Egy tick — a BLE indicate nem azonnali, hanem a következő ütemben érkezik. */
function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeNoRoutingCharacteristic extends EventEmitter {
  constructor(uuid, properties, robot, role) {
    super();
    this.uuid = canonicalUuid(uuid);
    this.properties = properties;
    this.name = '';
    this._robot = robot;
    this._role = role; // 'request' | 'requestReply' | 'action' | 'actionReply'
  }

  async writeAsync(data) {
    const buf = Buffer.from(data);
    if (this._role === 'request') {
      this._robot.handleRequest(buf);
    } else if (this._role === 'action') {
      this._robot.handleAction(buf);
    }
  }

  async subscribeAsync() {
    if (this._role === 'requestReply') this._robot.subRequestReply = true;
    if (this._role === 'actionReply') this._robot.subActionReply = true;
  }

  async unsubscribeAsync() {
    if (this._role === 'requestReply') this._robot.subRequestReply = false;
    if (this._role === 'actionReply') this._robot.subActionReply = false;
  }

  /** A readAsync a tartalék olvasásra szolgál (ha az indicate nem érkezik meg). */
  async readAsync() {
    if (this._role === 'requestReply') {
      return this._robot.lastRequestReply || Buffer.alloc(0);
    }
    if (this._role === 'actionReply') {
      return this._robot.lastActionReply || Buffer.alloc(0);
    }
    return Buffer.alloc(0);
  }
}

export class FakeNoRoutingCodie extends EventEmitter {
  /**
   * @param {{
   *   address?: string,
   *   name?: string,
   *   values?: {
   *     battery?: number,   // % (1 bájt)
   *     distance?: number,  // 0.1 mm egységben (raw, 2 bájt)
   *     light?: number,     // raw 12 bit (2 bájt)
   *     sound?: number,     // raw (2 bájt)
   *     line?: number       // raw 32 bit (4 bájt)
   *   },
   *   dropFirstFrame?: boolean
   * }} options
   */
  constructor({
    address = '00:07:80:66:F0:DB',
    name = 'Codie',
    // az élő roboton mért értékek (2026-10-20)
    values = { battery: 97, distance: 1232, light: 4002, sound: 69, line: 93325135 },
    dropFirstFrame = true,
  } = {}) {
    super();
    this.id = address.replace(/:/g, '').toLowerCase();
    this.address = address;
    this.name = name;
    this.values = { ...values };
    this.dropFirstFrame = dropFirstFrame;
    this.state = 'disconnected';

    /** Indicate-feliratkozás állapota a reply-karakterisztikákon. */
    this.subRequestReply = false;
    this.subActionReply = false;

    /** Beérkezett érzékelő-kérések: { seq, cmd, params, raw } */
    this.receivedRequests = [];
    /** Beérkezett parancsok: { seq, cmd, params, raw } */
    this.receivedActions = [];
    /** Elküldött válaszok: { kind, seq, value, raw } */
    this.sentReplies = [];
    /** Eldobott frame-ek: { kind, seq, cmd, reason } */
    this.droppedFrames = [];

    /** Az utolsó reply (a readAsync ezt adja vissza). */
    this.lastRequestReply = null;
    this.lastActionReply = null;

    // a parancsok dekódolt állapota (a tesztek ezt ellenőrzik)
    this.lastEcho = null;
    this.lastMove = null;
    this.lastMotor = null;
    this.lastMotorLeft = null;
    this.lastMotorRight = null;
    this.lastTurn = null;
    this.lastBeep = null;
    this.lastLed = null;
    this.lastAnimation = null;

    this._inFlight = { request: false, action: false };
    this._seenFirstFrame = false;

    // Advertisement (a scanner ezt látja)
    this.advertisement = {
      localName: name,
      serviceUuids: [canonicalUuid(np.SERVICE_UUID)],
      serviceData: [],
      serviceSolicitationUuids: [],
      manufacturerData: Buffer.from([]),
      txPowerLevel: 0,
    };
    this.rssi = -55;

    // Karakterisztikák (a noble/BlueZ a UUID-kat kötőjel nélkül, kisbetűsen adja)
    this.requestChar = new FakeNoRoutingCharacteristic(
      np.REQUEST_UUID,
      ['write', 'writeWithoutResponse'],
      this,
      'request',
    );
    this.requestReplyChar = new FakeNoRoutingCharacteristic(
      np.REQUEST_REPLY_UUID,
      ['read', 'indicate'],
      this,
      'requestReply',
    );
    this.actionChar = new FakeNoRoutingCharacteristic(
      np.ACTION_UUID,
      ['write', 'writeWithoutResponse'],
      this,
      'action',
    );
    this.actionReplyChar = new FakeNoRoutingCharacteristic(
      np.ACTION_REPLY_UUID,
      ['indicate'],
      this,
      'actionReply',
    );
  }

  /** A hirdetett karakterisztikák UUID-ja (a felismerés tesztjéhez). */
  get characteristicUuids() {
    return [
      this.requestChar.uuid,
      this.requestReplyChar.uuid,
      this.actionChar.uuid,
      this.actionReplyChar.uuid,
    ];
  }

  // --- noble peripheral felület ----------------------------------------

  async connectAsync() {
    this.state = 'connected';
    // egy új kapcsolat: a firmware újra eldobja az első frame-et
    this._seenFirstFrame = false;
    this._inFlight = { request: false, action: false };
    this.receivedRequests = [];
    this.receivedActions = [];
    this.sentReplies = [];
    this.droppedFrames = [];
  }

  async disconnectAsync() {
    this.state = 'disconnected';
    this.emit('disconnect', 'local');
  }

  async discoverAllServicesAndCharacteristicsAsync() {
    const characteristics = [
      this.requestChar,
      this.requestReplyChar,
      this.actionChar,
      this.actionReplyChar,
    ];
    const service = {
      uuid: canonicalUuid(np.SERVICE_UUID),
      name: 'Codie No-Routing',
      characteristics,
    };
    return { services: [service], characteristics };
  }

  // --- protokoll -------------------------------------------------------

  /** REQUEST karakterisztikára érkezett érzékelő-kérés. */
  handleRequest(frame) {
    this._handleFrame('request', frame);
  }

  /** ACTION karakterisztikára érkezett parancs. */
  handleAction(frame) {
    this._handleFrame('action', frame);
  }

  /** A beérkezett frame feldolgozása (a firmware viselkedésével). */
  _handleFrame(kind, frame) {
    if (!frame || frame.length < 4) return; // SEQ(2) + CMD(2) minimum
    const seq = frame.readUInt16LE(0);
    const cmd = frame.readUInt16LE(2);
    const params = Buffer.from(frame.subarray(4));
    const record = { seq, cmd, params, raw: Buffer.from(frame) };
    (kind === 'request' ? this.receivedRequests : this.receivedActions).push(record);

    // 1) a firmware connect után az első frame-et eldobja (nincs válasz)
    if (this.dropFirstFrame && !this._seenFirstFrame) {
      this._seenFirstFrame = true;
      this.droppedFrames.push({ ...record, kind, reason: 'first-frame' });
      return;
    }

    // 2) a még folyamatban lévő kérésre érkező frame eldobódik
    if (this._inFlight[kind]) {
      this.droppedFrames.push({ ...record, kind, reason: 'overlap' });
      return;
    }

    const value = kind === 'request'
      ? this._sensorValueFor(cmd)
      : this._actionValueFor(cmd, params, seq);
    if (value === null) {
      // ismeretlen érzékelő-lekérdezés -> a firmware nem válaszol
      this.droppedFrames.push({ ...record, kind, reason: 'unknown-command' });
      return;
    }

    this._inFlight[kind] = true;
    const reply = this._buildReply(seq, value.bytes);
    setImmediate(() => {
      this._inFlight[kind] = false;
      this.sentReplies.push({ kind, seq, value: value.number, raw: reply });
      if (kind === 'request') {
        this.lastRequestReply = reply;
        if (this.subRequestReply) this.requestReplyChar.emit('data', reply, true);
      } else {
        this.lastActionReply = reply;
        if (this.subActionReply) this.actionReplyChar.emit('data', reply, true);
      }
    });
  }

  /** Érzékelő-válasz: a mért szélességű VALUE (1 / 2 / 4 bájt). */
  _sensorValueFor(cmd) {
    switch (cmd) {
      case np.QUERY_BATTERY: {
        const value = this.values.battery & 0xff;
        return { bytes: Buffer.from([value]), number: value };
      }
      case np.QUERY_DISTANCE: {
        const value = this.values.distance & 0xffff;
        return { bytes: u16le(value), number: value };
      }
      case np.QUERY_LIGHT: {
        const value = this.values.light & 0xffff;
        return { bytes: u16le(value), number: value };
      }
      case np.QUERY_SOUND: {
        const value = this.values.sound & 0xffff;
        return { bytes: u16le(value), number: value };
      }
      case np.QUERY_LINE: {
        const value = this.values.line >>> 0;
        return { bytes: u32le(value), number: value };
      }
      default:
        return null;
    }
  }

  /** Parancs-nyugta: 1 bájt (0x00) — közben dekódoljuk a paramétereket. */
  _actionValueFor(cmd, params, seq) {
    switch (cmd) {
      case np.CMD_ECHO:
        this.lastEcho = { seq };
        break;
      case np.CMD_MOVE:
        this.lastMove = {
          distanceMm: params.length >= 2 ? params.readUInt16LE(0) : 0,
          left: params.length >= 3 ? i8(params[2]) : 0,
          right: params.length >= 4 ? i8(params[3]) : 0,
        };
        break;
      case np.CMD_MOTOR_BOTH:
        this.lastMotor = {
          left: params.length >= 1 ? i8(params[0]) : 0,
          right: params.length >= 2 ? i8(params[1]) : 0,
        };
        break;
      case np.CMD_MOTOR_LEFT:
        this.lastMotorLeft = { speed: params.length >= 1 ? i8(params[0]) : 0 };
        break;
      case np.CMD_MOTOR_RIGHT:
        this.lastMotorRight = { speed: params.length >= 1 ? i8(params[0]) : 0 };
        break;
      case np.CMD_TURN:
        this.lastTurn = {
          degree: params.length >= 2 ? params.readUInt16LE(0) : 0,
          speed: params.length >= 3 ? i8(params[2]) : 0,
        };
        break;
      case np.CMD_BEEP:
        this.lastBeep = {
          volume: params.length >= 1 ? params[0] : 0,
          frequency: params.length >= 3 ? params.readUInt16LE(1) : 0,
          durationMs: params.length >= 5 ? params.readUInt16LE(3) : 0,
        };
        break;
      case np.CMD_SET_COLOR:
        this.lastLed = {
          hue: params.length >= 1 ? params[0] : 0,
          sat: params.length >= 2 ? params[1] : 0,
          value: params.length >= 3 ? params[2] : 0,
        };
        break;
      case np.CMD_SET_ANIMATION:
        this.lastAnimation = {
          animation: params.length >= 1 ? params[0] : 0,
          hue: params.length >= 2 ? params[1] : 0,
          sat: params.length >= 3 ? params[2] : 0,
          repeat: params.length >= 4 ? params[3] : 0,
          speed: params.length >= 5 ? params[4] : 0,
        };
        break;
      default:
        break;
    }
    return { bytes: Buffer.from([0x00]), number: 0 };
  }

  /** Válasz-frame: SEQ(2 LE) | VALUE(változó hosszúságú, LE). */
  _buildReply(seq, valueBytes) {
    const head = Buffer.from([seq & 0xff, (seq >> 8) & 0xff]);
    return Buffer.concat([head, valueBytes]);
  }
}

/** Minimális noble-utánzat a no-routing peripheralokhoz. */
export class FakeNoRoutingNoble extends EventEmitter {
  constructor(peripherals = []) {
    super();
    this.state = 'poweredOn';
    this.peripherals = peripherals;
    this.scanning = false;
  }

  async waitForPoweredOnAsync() {}

  async connectAsync(idOrAddress) {
    const wanted = String(idOrAddress).replace(/:/g, '').toLowerCase();
    const peripheral = this.peripherals.find((p) => p.id === wanted);
    if (!peripheral) throw new Error(`unknown peripheral ${idOrAddress}`);
    await peripheral.connectAsync();
    return peripheral;
  }

  async startScanningAsync() {
    this.scanning = true;
    for (const peripheral of this.peripherals) {
      setTimeout(() => this.emit('discover', peripheral), 1);
    }
  }

  async stopScanningAsync() {
    this.scanning = false;
  }
}

/** Hamis scanner a no-routing robotokhoz. */
export class FakeNoRoutingScanner {
  constructor(peripherals = []) {
    this.peripherals = peripherals;
  }

  async scan() {
    return this.peripherals.map((peripheral) => ({
      address: peripheral.id.toUpperCase(),
      name: peripheral.advertisement.localName,
      rssi: peripheral.rssi,
      serviceUuids: peripheral.advertisement.serviceUuids,
      reasons: ['name'],
    }));
  }

  async findPeripheral(address) {
    const wanted = address.replace(/:/g, '').toLowerCase();
    return this.peripherals.find((p) => p.id === wanted) || null;
  }

  /** Felébresztő scan (a valós scannerhez hasonlóan). */
  async wakeScan(address) {
    return this.findPeripheral(address);
  }

  /** A valós scannerhez hasonlóan: a hirdetésre hívja a callbacket. */
  async connectSession(address, { onPeripheral } = {}) {
    const peripheral = await this.findPeripheral(address);
    if (peripheral && onPeripheral) await onPeripheral(peripheral);
  }
}

export { nextTick };
