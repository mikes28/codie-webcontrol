/**
 * RobotRegistry — több Codie robot kezelése egy szerveren.
 *
 * Minden robot kap egy saját `CodieClient`-et (saját BLE-kapcsolat), a
 * registry pedig közös felületet ad a REST API-nak, a scripteknek és a
 * socket.io eseményeknek.
 */

'use strict';

import { EventEmitter } from 'node:events';

import { CodieClient } from './client.js';
import { RobotScanner } from './scanner.js';
import { normalizeAddress } from './noble.js';
import { runCommand } from '../commands.js';

export class RobotRegistry extends EventEmitter {
  /**
   * @param {{noble: object, filters: object, connectTimeout?: number,
   *          connectRetries?: number, retryDelay?: number, telemetryMs?: number}} options
   */
  constructor({
    noble,
    filters = {},
    scanner = null,
    connectTimeout = 20000,
    scanWindow = 8000,
    connectRetries = 3,
    retryDelay = 3000,
    telemetryMs = 5000,
  }) {
    super();
    this.filters = filters;
    this.scanner = scanner || new RobotScanner({ noble, filters });
    this._robots = new Map(); // address -> robot entry
    this._telemetryMs = telemetryMs;
    this._telemetryTimer = null;
    this._connectOptions = { timeout: connectTimeout, scanWindow, connectRetries, retryDelay };
  }

  // --- felderítés ------------------------------------------------------

  /**
   * Robotok keresése — csak a szűrőnek megfelelő BLE eszközök jönnek vissza.
   * @param {{durationMs?: number, onFound?: (robot: object) => void}} options
   */
  async scan(options = {}) {
    const robots = await this.scanner.scan(options);
    for (const robot of robots) {
      const key = normalizeAddress(robot.address);
      const existing = this._robots.get(key);
      if (existing) {
        existing.name = robot.name || existing.name;
        existing.rssi = robot.rssi;
        existing.lastSeen = robot.lastSeen;
        existing.seen = true;
      } else {
        this._robots.set(key, {
          address: key,
          name: robot.name,
          rssi: robot.rssi,
          connected: false,
          seen: true,
          firstSeen: robot.firstSeen,
          lastSeen: robot.lastSeen,
          reasons: robot.reasons,
          client: null,
          telemetry: null,
        });
      }
    }
    const found = robots.map((robot) => this.describe(robot.address));
    this.emit('scan', found);
    return found;
  }

  // --- kapcsolat -------------------------------------------------------

  /** Csatlakozik egy robothoz (cím alapján). */
  async connect(address) {
    const key = normalizeAddress(address);
    const existing = this._robots.get(key);
    if (existing && existing.connected && existing.client?.isConnected) {
      return this.describe(key);
    }

    const client = new CodieClient({
      address: key,
      noble: this.noble,
      scanner: this.scanner,
      ...this._connectOptions,
    });
    client.on('disconnected', () => {
      const entry = this._robots.get(key);
      if (entry) {
        entry.connected = false;
        entry.client = null;
        this.emit('robot', this.describe(key));
      }
    });

    const entry = existing || {
      address: key,
      name: '',
      rssi: null,
      firstSeen: Date.now(),
      reasons: [],
      telemetry: null,
    };
    entry.client = client;
    entry.connected = false;
    this._robots.set(key, entry);

    try {
      await client.connect();
    } catch (error) {
      // a sikertelen kapcsolatot nem hagyjuk "félig" a registryben
      entry.client = null;
      entry.connected = false;
      this.emit('robot', this.describe(key));
      throw error;
    }
    entry.connected = true;
    entry.connectedAt = Date.now();
    this.emit('robot', this.describe(key));
    this._startTelemetry();
    return this.describe(key);
  }

  /** Lekapcsol egy robotot. */
  async disconnect(address) {
    const key = normalizeAddress(address);
    const entry = this._robots.get(key);
    if (!entry || !entry.client) return this.describe(key);
    await entry.client.disconnect();
    entry.connected = false;
    entry.client = null;
    this.emit('robot', this.describe(key));
    if (![...this._robots.values()].some((r) => r.connected)) this._stopTelemetry();
    return this.describe(key);
  }

  async disconnectAll() {
    for (const entry of [...this._robots.values()]) {
      if (entry.client) {
        try {
          await entry.client.disconnect();
        } catch {
          /* leállásnál nem kritikus */
        }
        entry.connected = false;
        entry.client = null;
      }
    }
    this._stopTelemetry();
  }

  // --- lekérdezés ------------------------------------------------------

  /** A registry összes ismert robotja (kapcsolattól függetlenül). */
  list() {
    return [...this._robots.keys()].map((key) => this.describe(key));
  }

  get(address) {
    const entry = this._robots.get(normalizeAddress(address));
    return entry ? this.describe(entry.address) : null;
  }

  /** A nyitott BLE-kapcsolatú robot kliensje (null, ha nincs). */
  clientFor(address) {
    const entry = this._robots.get(normalizeAddress(address));
    if (!entry || !entry.client || !entry.client.isConnected) return null;
    return entry.client;
  }

  /** Magas szintű parancs végrehajtása (a `commands.js` szemantikájával). */
  async command(address, name, params = {}) {
    const client = this.clientFor(address);
    if (!client) {
      throw new Error(`A ${normalizeAddress(address)} robot nincs csatlakoztatva.`);
    }
    const result = await runCommand(client, name, params);
    this.emit('command', { address: normalizeAddress(address), ...result });
    return result;
  }

  // --- telemetria ------------------------------------------------------

  _startTelemetry() {
    if (this._telemetryTimer || !this._telemetryMs) return;
    this._telemetryTimer = setInterval(() => {
      this._pollTelemetry().catch(() => {
        /* a telemetria hibája nem állíthatja le a szervert */
      });
    }, this._telemetryMs);
    this._telemetryTimer.unref?.();
  }

  _stopTelemetry() {
    if (!this._telemetryTimer) return;
    clearInterval(this._telemetryTimer);
    this._telemetryTimer = null;
  }

  async _pollTelemetry() {
    for (const entry of this._robots.values()) {
      if (!entry.connected || !entry.client) continue;
      try {
        const status = await entry.client.status();
        entry.telemetry = { ...status, updatedAt: Date.now() };
        this.emit('telemetry', this.describe(entry.address));
      } catch {
        /* egy robot hibája ne szakítsa meg a többi telemetriát */
      }
    }
  }

  // --- leírás ----------------------------------------------------------

  /** Nyilvános (JSON-barát) leírás a robotról. */
  describe(address) {
    const key = normalizeAddress(address);
    const entry = this._robots.get(key);
    if (!entry) {
      return { address: key, name: '', connected: false, seen: false, telemetry: null };
    }
    return {
      address: entry.address,
      name: entry.name || '',
      rssi: entry.rssi ?? null,
      connected: Boolean(entry.connected && entry.client?.isConnected),
      seen: Boolean(entry.seen),
      firstSeen: entry.firstSeen ?? null,
      lastSeen: entry.lastSeen ?? null,
      connectedAt: entry.connectedAt ?? null,
      reasons: entry.reasons ?? [],
      telemetry: entry.telemetry ?? null,
    };
  }
}
