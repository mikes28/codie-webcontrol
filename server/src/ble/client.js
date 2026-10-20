/**
 * CodieClient — egy robot BLE-kapcsolata (a Python `codie/client.py` portja).
 *
 * A kliens csatlakozik, feliratkozik a notify-csatornára, és a kérés SEQ ->
 * válasz REQSEQ párosítással kéri le a szenzorértékeket. Az aktuátor-parancsok
 * (beep, LED, mozgás) is várnak nyugtára, de ha nem jön, `null`-t adnak vissza.
 */

'use strict';

import { EventEmitter } from 'node:events';

import * as p from './protocol.js';
import * as morse from '../morse.js';
import * as tunes from '../tunes.js';
import { normalizeAddress } from './noble.js';

export class CodieClient extends EventEmitter {
  /**
   * @param {{address: string, noble: object, scanner: object, timeout?: number,
   *          connectRetries?: number, retryDelay?: number, responseTimeout?: number}} options
   */
  constructor({
    address,
    noble,
    scanner,
    timeout = 20000,
    scanWindow = 8000,
    connectRetries = 3,
    retryDelay = 3000,
    responseTimeout = 2500,
  }) {
    super();
    this.address = normalizeAddress(address);
    this.noble = noble;
    this.scanner = scanner;
    this._connectTimeout = timeout;
    this._scanWindow = scanWindow;
    this._connectRetries = Math.max(1, connectRetries);
    this._retryDelay = retryDelay;
    this._responseTimeout = responseTimeout;

    this._peripheral = null;
    this._writeChar = null;
    this._notifyChar = null;
    this._pending = new Map();
    this.notifications = [];
  }

  // --- életciklus ------------------------------------------------------

  /**
   * Csatlakozás retry-jal + felébresztő scannel.
   *
   * A Codie egy idő után elalszik; ilyenkor az első connect timeoutol. Egy BLE-scan
   * felébreszti / újrafelfedezteti a BlueZ-vel, majd újrapróbáljuk — így egy elalvás
   * nem bukik el tévedésből.
   *
   * A lényeg: **egyetlen** BlueZ-connectet indítunk, és arra türelmesen várunk. A BlueZ
   * a háttérben újrapróbálkozik, és amikor a robot felébred, befejezi a kapcsolatot —
   * a retry-k ugyanarra a connect-promise-re várnak, tehát a kapcsolat nem szakad meg
   * a próbálkozások között.
   */
  async connect() {
    let lastError = null;
    let connectPromise = null;
    let connectRejected = false;

    for (let attempt = 1; attempt <= this._connectRetries; attempt += 1) {
      try {
        if (!connectPromise) {
          const peripheral = await this.scanner.findPeripheral(this.address, {
            durationMs: this._scanWindow,
          });
          if (!peripheral) {
            throw new Error(`A ${this.address} robot nem jelent meg a scanben (elalvott?).`);
          }
          this._peripheral = peripheral;
          peripheral.on('disconnect', () => this._handleDisconnect());
          // Ha a BlueZ egy korábbi próbálkozás után közben befejezte a kapcsolatot,
          // nem indítunk újabb connectet (az "already connected" hibával elhasalna).
          if (peripheral.state !== 'connected') {
            connectPromise = peripheral.connectAsync();
            connectPromise.catch(() => {
              connectRejected = true;
            });
          }
        }

        if (connectPromise) {
          await withTimeout(
            connectPromise,
            this._connectTimeout,
            `connect timeout (${this._connectTimeout} ms) — a ${this.address} robot nem válaszol`,
          );
        }

        const { writeChar, notifyChar } = await this._resolveCharacteristics();
        this._writeChar = writeChar;
        this._notifyChar = notifyChar;

        if (notifyChar) {
          notifyChar.on('data', (data) => this._onNotify(data));
          await notifyChar.subscribeAsync();
        }

        this.emit('connected', this.address);
        return this;
      } catch (error) {
        lastError = error;
        this.emit('connect-error', this.address, error);
        if (connectRejected) {
          // A BlueZ elutasította a connectet (pl. "already in progress"): újrakezdés.
          connectPromise = null;
          connectRejected = false;
        }
        if (attempt < this._connectRetries) {
          await sleep(this._retryDelay);
        }
      }
    }

    await this._cleanupPartial();
    throw lastError;
  }

  /** Megkeresi a write és notify karakterisztikát (a BlueZ későn publikálhatja). */
  async _resolveCharacteristics() {
    const deadline = Date.now() + this._connectTimeout;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const { characteristics } = await this._peripheral.discoverAllServicesAndCharacteristicsAsync();
        const writeChar = characteristics.find((c) => p.sameUuid(c.uuid, p.WRITE_UUID));
        const notifyChar = characteristics.find((c) => p.sameUuid(c.uuid, p.NOTIFY_UUID));
        if (writeChar) return { writeChar, notifyChar };
        lastError = new Error(
          `A write karakterisztika (${p.WRITE_UUID}) nem található a ${this.address} roboton.`,
        );
      } catch (error) {
        lastError = error;
      }
      await sleep(500);
    }
    throw lastError || new Error('A GATT szolgáltatás nem oldódott fel.');
  }

  async _cleanupPartial() {
    this._writeChar = null;
    this._notifyChar = null;
    const peripheral = this._peripheral;
    this._peripheral = null;
    if (!peripheral) return;
    try {
      // A BlueZ egy félbehagyott connectre nem mindig válaszol azonnal a Disconnect()-re,
      // ezért a takarítás időtartam-biztosított — nem akadhat el a kliens.
      await withTimeout(peripheral.disconnectAsync(), 5000, 'disconnect timeout');
    } catch {
      /* a takarítás nem kritikus */
    }
  }

  async disconnect() {
    if (this._notifyChar) {
      try {
        await this._notifyChar.unsubscribeAsync();
      } catch {
        /* nem kritikus */
      }
    }
    await this._cleanupPartial();
    this.emit('disconnected', this.address);
  }

  get isConnected() {
    return Boolean(this._peripheral) && this._peripheral.state === 'connected';
  }

  _handleDisconnect() {
    this._peripheral = null;
    this._writeChar = null;
    this._notifyChar = null;
    for (const [, resolver] of this._pending) resolver(null);
    this._pending.clear();
    this.emit('disconnected', this.address);
  }

  // --- notify kezelés --------------------------------------------------

  _onNotify(data) {
    const raw = Buffer.from(data);
    const resp = p.decodeResponse(raw);
    this.notifications.push({ raw, resp });
    if (resp) {
      const resolver = this._pending.get(resp.reqSeq);
      if (resolver) {
        this._pending.delete(resp.reqSeq);
        resolver(resp);
      }
    }
  }

  // --- alap küldés/válasz ---------------------------------------------

  /**
   * Parancs küldése a write karakterisztikára.
   * @returns {Promise<object|null>} a dekódolt válasz, vagy null (timeout/nincs nyugta)
   */
  async send(cmdId, args = Buffer.alloc(0), { expectResponse = true, timeout = this._responseTimeout } = {}) {
    if (!this._writeChar) {
      throw new Error('Nincs kapcsolat — hívd előbb a connect()-et.');
    }
    const { frame, seq } = p.buildFrame(cmdId, args);
    let resolver = null;
    if (expectResponse) {
      const promise = new Promise((resolve) => {
        resolver = resolve;
      });
      this._pending.set(seq, resolver);
      await this._writeChar.writeAsync(frame, true); // write-without-response
      const timer = setTimeout(() => {
        if (this._pending.delete(seq)) resolver(null);
      }, timeout);
      try {
        return await promise;
      } finally {
        clearTimeout(timer);
        this._pending.delete(seq);
      }
    }
    await this._writeChar.writeAsync(frame, true);
    return null;
  }

  // --- aktuátorok ------------------------------------------------------

  async beep(durationMs = 1000) {
    return this.send(p.CMD_SPEAK_BEEP, p.beepArgs(durationMs));
  }

  /**
   * Ritmusminta lejátszása: [[csipogás_ms, szünet_ms], ...].
   * Fire-and-forget beepek, a ritmust lokális várakozás adja.
   */
  async playRhythm(pattern) {
    for (const [beepMs, gapMs] of pattern) {
      await this.send(p.CMD_SPEAK_BEEP, p.beepArgs(Math.trunc(beepMs)), { expectResponse: false });
      await sleep((beepMs + gapMs) / 1000);
    }
  }

  async playMorse(text, unitMs = 120) {
    await this.playRhythm(morse.textToRhythm(text, unitMs));
  }

  async playTune(name) {
    const pattern = tunes.RHYTHMS[name];
    if (!pattern) {
      throw new Error(
        `Ismeretlen ritmus: ${JSON.stringify(name)}. Elérhető: ${tunes.names().join(', ')}`,
      );
    }
    await this.playRhythm(pattern);
  }

  async ledAll(color = 'green') {
    return this.send(p.CMD_LED_SET_COLOR, p.ledAllArgs(color));
  }

  async ledSingle(color, index) {
    return this.send(p.CMD_LED_SET_COLOR, p.ledSingleArgs(color, index));
  }

  /** "kikapcsolt" = value 0 (fekete) */
  async ledsOff() {
    return this.send(p.CMD_LED_SET_COLOR, Buffer.concat([p.u16(0x0fff), p.u8(0), p.u8(0), p.u8(0)]));
  }

  async driveSpeed(left, right) {
    return this.send(p.CMD_DRIVE_SPEED, p.driveSpeedArgs(left, right));
  }

  async stop() {
    return this.driveSpeed(0, 0);
  }

  async driveDistance(distanceMm, left = 30, right = 30) {
    return this.send(p.CMD_DRIVE_DISTANCE, p.driveDistanceArgs(distanceMm, left, right));
  }

  async driveTurn(degree, speed = 30) {
    return this.send(p.CMD_DRIVE_TURN, p.driveTurnArgs(degree, speed));
  }

  // --- szenzorok -------------------------------------------------------

  async battery() {
    const r = await this.send(p.CMD_BATTERY);
    return r ? p.readU8(r.args, 0) : null;
  }

  async light() {
    const r = await this.send(p.CMD_LIGHT);
    return r ? p.readU16(r.args, 0) : null;
  }

  async line() {
    const r = await this.send(p.CMD_LINE);
    if (!r) return null;
    return { left: p.readU16(r.args, 0), right: p.readU16(r.args, 2) };
  }

  async sonar() {
    const r = await this.send(p.CMD_SONAR);
    return r ? p.readU16(r.args, 0) : null;
  }

  async mic() {
    const r = await this.send(p.CMD_MIC);
    return r ? p.readU16(r.args, 0) : null;
  }

  async batteryVoltage() {
    const r = await this.send(p.CMD_BATTERY_VOLTAGE);
    return r ? p.readU16(r.args, 0) : null;
  }

  /** A robot pillanatnyi állapota — egy csomagban minden szenzor. */
  async status() {
    const [batteryPct, sonarMm, lightRaw, line] = await Promise.all([
      this.battery(),
      this.sonar(),
      this.light(),
      this.line(),
    ]);
    return {
      batteryPct,
      sonarMm,
      lightRaw,
      line,
      voltageMv: await this.batteryVoltage(),
    };
  }

  // --- protokoll-jelzések (hivatalos SDK) ------------------------------

  async appConnected() {
    return this.send(p.CMD_APP_CONNECTED);
  }

  async appDisconnected() {
    return this.send(p.CMD_APP_DISCONNECTED);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
