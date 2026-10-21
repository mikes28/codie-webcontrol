/**
 * Hamis Codie robot — a GATT-felület emulálja, hogy a teljes backend
 * (scan → szűrés → connect → parancs → telemetria → REST/socket) futtatható
 * legyen a valódi hardver nélkül.
 *
 * A protokoll oldalról a Python referencia szerint működik:
 *   kérés : INFO(1) SEQ(2) CMD(2) ARGLEN(2) ARG...
 *   válasz: INFO(1) SEQ(2) CMD(2|0x8000) ARGLEN(2) REQSEQ(2) ARG...
 */

import { EventEmitter } from 'node:events';

import * as p from '../src/ble/protocol.js';

/** A Codie válaszframe-jében a CMD felső bitje 0x80 = MCU→APP. */
const RESPONSE_FLAG = 0x8000;

class FakeCharacteristic extends EventEmitter {
  constructor(uuid, properties, robot, role) {
    super();
    this.uuid = uuid;
    this.properties = properties;
    this.name = '';
    this._robot = robot;
    this._role = role;
  }

  async writeAsync(data) {
    this._robot.handleFrame(Buffer.from(data));
  }

  async subscribeAsync() {
    this._robot.subscribed = true;
  }

  async unsubscribeAsync() {
    this._robot.subscribed = false;
  }
}

export class FakeCodie extends EventEmitter {
  /**
   * @param {{address?: string, name?: string, values?: object, respondToVoltage?: boolean}} options
   */
  constructor({
    address = '00:07:80:66:F0:DB',
    name = 'Codie',
    values = { battery: 85, sonar: 300, light: 4041, line: [3895, 3808], mic: 633 },
    respondToVoltage = false,
  } = {}) {
    super();
    this.id = address.replace(/:/g, '').toLowerCase();
    this.address = address;
    this.name = name;
    this.values = { ...values };
    this.respondToVoltage = respondToVoltage;
    this.state = 'disconnected';
    this.subscribed = false;
    /** A beérkezett parancsok: { cmd, args } */
    this.received = [];
    this._responseSeq = 10;

    this.advertisement = {
      localName: name,
      // a valós BlueZ binding is így adja vissza: kötőjel nélkül, kisbetűsen
      serviceUuids: [
        p.canonicalUuid(p.SERVICE_UUID),
        p.canonicalUuid('d46e7e53-ba2f-4044-ade9-f85ead45f458'),
      ],
      serviceData: [],
      serviceSolicitationUuids: [],
      manufacturerData: Buffer.from([]),
      txPowerLevel: 0,
    };
    this.rssi = -55;

    this._writeChar = new FakeCharacteristic(p.canonicalUuid(p.WRITE_UUID), ['write', 'writeWithoutResponse'], this, 'write');
    this._notifyChar = new FakeCharacteristic(p.canonicalUuid(p.NOTIFY_UUID), ['notify'], this, 'notify');
  }

  // --- noble peripheral felület ----------------------------------------

  async connectAsync() {
    this.state = 'connected';
  }

  async disconnectAsync() {
    this.state = 'disconnected';
    this.emit('disconnect', 'local');
  }

  async discoverAllServicesAndCharacteristicsAsync() {
    const service = {
      uuid: p.SERVICE_UUID,
      name: 'Codie Vendor',
      characteristics: [this._writeChar, this._notifyChar],
    };
    return { services: [service], characteristics: [this._writeChar, this._notifyChar] };
  }

  // --- protokoll -------------------------------------------------------

  /** A beérkezett frame feldolgozása és a válasz visszaküldése. */
  handleFrame(frame) {
    if (frame.length < 7) return;
    const seq = frame[1] | (frame[2] << 8);
    const cmd = frame[3] | (frame[4] << 8);
    const arglen = frame[5] | (frame[6] << 8);
    const args = frame.subarray(7, 7 + arglen);
    this.received.push({ cmd, args: Buffer.from(args), seq });

    const response = this._buildResponse(cmd, args, seq);
    if (response && this.subscribed) {
      // a notify-csatornán érkezik
      this._notifyChar.emit('data', response);
    }
  }

  _buildResponse(cmd, args, reqSeq) {
    const payload = this._payloadFor(cmd, args);
    if (payload === null) return null;
    this._responseSeq = (this._responseSeq + 1) & 0xffff;
    const header = Buffer.from([
      0x10, // INFO: MCU -> APP
      this._responseSeq & 0xff,
      (this._responseSeq >> 8) & 0xff,
      cmd & 0xff,
      ((cmd | RESPONSE_FLAG) >> 8) & 0xff,
      payload.length & 0xff,
      (payload.length >> 8) & 0xff,
      reqSeq & 0xff,
      (reqSeq >> 8) & 0xff,
    ]);
    return Buffer.concat([header, payload]);
  }

  _payloadFor(cmd, args) {
    switch (cmd) {
      case p.CMD_BATTERY:
        return Buffer.from([this.values.battery & 0xff]);
      case p.CMD_LIGHT:
        return p.u16(this.values.light);
      case p.CMD_LINE:
        return Buffer.concat([p.u16(this.values.line[0]), p.u16(this.values.line[1])]);
      case p.CMD_SONAR:
        return p.u16(this.values.sonar);
      case p.CMD_MIC:
        return p.u16(this.values.mic);
      case p.CMD_BATTERY_VOLTAGE:
        // ezen a firmware-en nincs válasz
        return this.respondToVoltage ? p.u16(3700) : null;
      case p.CMD_SPEAK_BEEP:
        this.lastBeep = { durationMs: args.length >= 2 ? args[0] | (args[1] << 8) : 0 };
        return Buffer.from([0x00]); // nSuccessful
      case p.CMD_LED_SET_COLOR: {
        const mask = args.length >= 2 ? args[0] | (args[1] << 8) : 0;
        this.lastLed = { mask, hue: args[2], sat: args[3], value: args[4] };
        return Buffer.from([0x00]);
      }
      case p.CMD_DRIVE_SPEED:
        this.lastDrive = { left: args[0] > 127 ? args[0] - 256 : args[0], right: args[1] > 127 ? args[1] - 256 : args[1] };
        return Buffer.from([0x00]);
      case p.CMD_DRIVE_DISTANCE:
        this.lastDistance = {
          distanceMm: args.length >= 2 ? args[0] | (args[1] << 8) : 0,
          left: args[2] > 127 ? args[2] - 256 : args[2],
          right: args[3] > 127 ? args[3] - 256 : args[3],
        };
        return Buffer.from([0x00]);
      case p.CMD_DRIVE_TURN:
        this.lastTurn = {
          degree: args.length >= 2 ? args[0] | (args[1] << 8) : 0,
          speed: args[2] > 127 ? args[2] - 256 : args[2],
        };
        return Buffer.from([0x00]);
      default:
        return Buffer.from([0x00]);
    }
  }
}

/** Minimális noble-utánzat, ami a megadott hamis peripheralokat hirdeti. */
export class FakeNoble extends EventEmitter {
  constructor(peripherals = []) {
    super();
    this.state = 'poweredOn';
    this.peripherals = peripherals;
    this.scanning = false;
  }

  async waitForPoweredOnAsync() {}

  /** A valós noble-hoz hasonlóan: címmel csatlakozik. */
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

/** Hamis scanner, ami a megadott peripheralokat adja vissza (cím szerint). */
export class FakeScanner {
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
