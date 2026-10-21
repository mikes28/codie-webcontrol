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

/**
 * A scan-idő normalizálása (ms): korlátok között, NaN nélkül.
 * @param {unknown} value
 * @param {number} fallback
 */
export function resolveScanDuration(value, fallback = 10000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1000), 120000);
}

/**
 * A mikrofon nyers értékének felső határa (a 100%-hoz tartozó érték).
 * A hivatalos Codie API szerint a `MicGetRaw` 0..~2048 közötti értéket ad.
 */
export const MIC_FULL_SCALE = 2048;

export class RobotRegistry extends EventEmitter {
  /**
   * @param {{noble: object, filters: object, connectTimeout?: number,
   *          connectRetries?: number, retryDelay?: number, telemetryMs?: number,
   *          autoReconnect?: boolean, reconnectAttempts?: number,
   *          reconnectDelayMs?: number}} options
   */
  constructor({
    noble,
    filters = {},
    scanner = null,
    connectTimeout = 20000,
    scanWindow = 8000,
    connectRetries = 3,
    retryDelay = 3000,
    responseTimeout = 2500,
    queryTimeout = 1200,
    writeTimeout = 3000,
    statusTimeout = 10000,
    writeGap = 150,
    telemetryMs = 250,
    micMs = 200,
    autoReconnect = true,
    reconnectAttempts = 3,
    reconnectDelayMs = 5000,
  }) {
    super();
    this.filters = filters;
    /** A BLE-példány — a kliens a címmel ezen keresztül csatlakozik. */
    this.noble = noble;
    this.scanner = scanner || new RobotScanner({ noble, filters });
    this._robots = new Map(); // address -> robot entry
    this._operations = new Map(); // address -> művelet-lánc (connect/disconnect szerializálás)
    this._telemetryMs = telemetryMs;
    this._telemetryTimer = null;
    /** A telemetria-kör generációja — a leállítás érvényteleníti a futó kört. */
    this._telemetryGeneration = 0;
    /** A mikrofon figyelésének periódusa (ms). */
    this._micMs = Math.max(50, micMs);
    /** Újracsatlakozás egy megszakadt kapcsolat után. */
    this._autoReconnect = autoReconnect;
    this._reconnectAttempts = Math.max(0, reconnectAttempts);
    this._reconnectDelayMs = reconnectDelayMs;
    this._connectOptions = {
      timeout: connectTimeout,
      scanWindow,
      connectRetries,
      retryDelay,
      responseTimeout,
      queryTimeout,
      writeTimeout,
      statusTimeout,
      writeGap,
    };
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

  /**
   * Egy adott robot műveletei (connect/disconnect) sorba állnak, hogy két
   * párhuzamos kérés ne hozzon létre két klienset ugyanahhoz a címhez.
   */
  _withLock(key, operation) {
    const previous = this._operations.get(key) || Promise.resolve();
    const current = previous.then(operation, operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this._operations.set(key, settled);
    // a bejegyzés csak akkor törlődik, ha ez a legutóbbi művelet (ha közben
    // új jött, azt meg kell tartani) — így a térkép nem nő a végtelenig
    settled.then(() => {
      if (this._operations.get(key) === settled) this._operations.delete(key);
    });
    return current;
  }

  /** Csatlakozik egy robothoz (cím alapján). */
  async connect(address) {
    const key = normalizeAddress(address);
    return this._withLock(key, () => this._connectRobot(key));
  }

  async _connectRobot(key) {
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
      // csak akkor nullázunk, ha ez a kliens a "hivatalos" — egy árva kliens
      // (egy megszakadt párhuzamos connect után) ne tegye offline-ba a robotot
      if (!entry || entry.client !== client) return;
      const wasConnected = entry.connected;
      entry.connected = false;
      entry.client = null;
      entry.reconnecting = false;
      // a mikrofon figyelését is le kell állítani: a régi kliens meghalt,
      // és a figyelés (a maga beállított állapota) a telemetriát **örökre**
      // letiltaná (a felületen a szenzorértékek befagynának)
      if (entry.micTimer) {
        clearInterval(entry.micTimer);
        entry.micTimer = null;
      }
      entry.micStreaming = false;
      this.emit('robot', this.describe(key));
      if (![...this._robots.values()].some((r) => r.connected)) this._stopTelemetry();
      // A kapcsolat váratlanul szakadt meg (a robot elalvelt / a link megszakadt):
      // a felhasználó továbbra is kapcsolódva akarja a robotot → újracsatlakozunk.
      if (wasConnected && entry.desired) this._scheduleReconnect(key);
    });
    // egy hibás BLE-csomag ne öljön meg semmit — a hiba a felületen jelenik meg
    client.on('ble-error', (error) => {
      this.emit('robot-error', {
        address: key,
        message: `BLE hiba: ${error.message}`,
      });
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
    // a felhasználó szándéka: a robot kapcsolódva legyen
    entry.desired = true;
    this._robots.set(key, entry);

    try {
      await client.connect();
      // Ha a link közvetlenül a connect után megszakadt, a kliens már nem
      // élő — ezt sikertelen connectként kell kezelni (különben a registry
      // ellentmondásos állapotban marad: "connected" flag, de nincs kliens).
      if (entry.client !== client || !client.isConnected) {
        throw new Error('A BLE-kapcsolat a csatlakozás után azonnal megszakadt.');
      }
    } catch (error) {
      // a sikertelen kapcsolatot nem hagyjuk "félig" a registryben
      if (entry.client === client) {
        entry.client = null;
        entry.connected = false;
      }
      this.emit('robot', this.describe(key));
      if (!error.status) error.status = 503; // a robot nem érhető el (alvó / nincs rá)
      // a felhasználó továbbra is kapcsolódva akarja a robotot → a háttérben
      // újracsatlakozunk (a robot ébredése után magától megvan)
      this._scheduleReconnect(key);
      throw error;
    }
    entry.connected = true;
    entry.connectedAt = Date.now();
    entry.reconnectAttempts = 0;
    entry.reconnecting = false;
    // a felismert generáció megőrződik, így lekapcsolás után is tudjuk mutatni
    entry.variant = client.variant;
    // a hirdetésből olvasott név (a connect előtti ébresztő scan adja) — enélkül
    // a felületen "(névtelen)" jelenne meg, ha a scan nem futott le előbb
    if (!entry.name && client.advertisedName) entry.name = client.advertisedName;
    this.emit('robot', this.describe(key));
    this._startTelemetry();
    return this.describe(key);
  }

  // --- újracsatlakozás ---------------------------------------------------

  /** Az újracsatlakozás időzítőjének törlése (a bejegyzéshez kötve). */
  _clearReconnectTimer(entry) {
    if (entry?.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
  }

  /**
   * Újracsatlakozás ütemezése egy megszakadt kapcsolat után.
   *
   * A Codie idővel elalszik, és az alvó robot nem fogad BLE-kapcsolatot —
   * a kliens connect-retry-ja (felébresztő scannel) ezt kezeli. A próbálkozások
   * korlátozottak, hogy a háttérben futő újracsatlakozás ne terhelje a rádiót.
   */
  _scheduleReconnect(key) {
    const entry = this._robots.get(key);
    if (!entry || !this._autoReconnect || !entry.desired) return;
    entry.reconnectAttempts = (entry.reconnectAttempts ?? 0) + 1;
    if (entry.reconnectAttempts > this._reconnectAttempts) {
      entry.reconnecting = false;
      this.emit('robot', this.describe(key));
      this.emit('robot-error', {
        address: key,
        message:
          `A kapcsolat megszakadt, és az újracsatlakozás sem sikerült ` +
          `(${this._reconnectAttempts} próbálkozás).`,
      });
      return;
    }
    entry.reconnecting = true;
    this.emit('robot', this.describe(key));
    const timer = setTimeout(() => {
      entry.reconnectTimer = null;
      this._reconnectRobot(key).catch(() => {
        /* a hiba a _reconnectRobot-ben kezelve van */
      });
    }, this._reconnectDelayMs);
    timer.unref?.();
    entry.reconnectTimer = timer;
  }

  async _reconnectRobot(key) {
    const entry = this._robots.get(key);
    if (!entry || !entry.desired) return;
    try {
      await this._withLock(key, () => this._connectRobot(key));
      entry.reconnectAttempts = 0;
      entry.reconnecting = false;
      this.emit('robot', this.describe(key));
    } catch (error) {
      entry.reconnecting = false;
      this.emit('robot', this.describe(key));
      this.emit('robot-error', {
        address: key,
        message: `Újracsatlakozás sikertelen: ${error.message}`,
      });
      this._scheduleReconnect(key);
    }
  }

  /** Lekapcsol egy robotot. */
  async disconnect(address) {
    const key = normalizeAddress(address);
    return this._withLock(key, () => this._disconnectRobot(key));
  }

  async _disconnectRobot(key) {
    const entry = this._robots.get(key);
    if (!entry) return this.describe(key);
    // a felhasználó szándéka: le akarja választani — ne próbáljunk újracsatlakozni
    entry.desired = false;
    entry.reconnecting = false;
    this._clearReconnectTimer(entry);
    if (entry.micTimer) {
      clearInterval(entry.micTimer);
      entry.micTimer = null;
      entry.micStreaming = false;
    }
    if (!entry.client) {
      this.emit('robot', this.describe(key));
      return this.describe(key);
    }
    const client = entry.client;
    await client.disconnect();
    if (entry.client === client) {
      entry.connected = false;
      entry.client = null;
    }
    this.emit('robot', this.describe(key));
    if (![...this._robots.values()].some((r) => r.connected)) this._stopTelemetry();
    return this.describe(key);
  }

  async disconnectAll() {
    for (const entry of [...this._robots.values()]) {
      entry.desired = false;
      entry.reconnecting = false;
      this._clearReconnectTimer(entry);
      if (entry.micTimer) {
        clearInterval(entry.micTimer);
        entry.micTimer = null;
        entry.micStreaming = false;
      }
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
      const error = new Error(`A ${normalizeAddress(address)} robot nincs csatlakoztatva.`);
      error.status = 409; // Conflict: a kérés érvényes, de a robot nincs rá
      throw error;
    }
    const result = await runCommand(client, name, params);
    this.emit('command', { address: normalizeAddress(address), ...result });
    return result;
  }

  // --- telemetria ------------------------------------------------------

  _startTelemetry() {
    if (this._telemetryTimer || !this._telemetryMs) return;
    // Önmagát újraütemező kör: a kívánt periódus a *cél*, de ha a robot nem
    // bírja (a válasz ~100 ms, 4 érzékelő = ~400 ms), a következő kör azonnal
    // indul — így a felület a lehető leggyorsabban frissül.
    //
    // A generációs számláló védi: ha a kört leállítják (vagy újraindítják) egy
    // futó lekérés közben, a régi kör nem ütemezheti újra magát.
    this._telemetryGeneration += 1;
    const generation = this._telemetryGeneration;
    const loop = async () => {
      const started = Date.now();
      this._polling = true;
      await this._pollTelemetry().catch(() => {
        /* a telemetria hibája nem állíthatja le a szervert */
      });
      this._polling = false;
      if (generation !== this._telemetryGeneration) return; // leállt vagy újraindított
      const wait = Math.max(0, this._telemetryMs - (Date.now() - started));
      this._telemetryTimer = setTimeout(loop, wait);
      this._telemetryTimer.unref?.();
    };
    this._telemetryTimer = setTimeout(loop, 0);
    this._telemetryTimer.unref?.();
  }

  _stopTelemetry() {
    // a futó kör érvénytelenítése (különben újraütemezné magát)
    this._telemetryGeneration += 1;
    if (!this._telemetryTimer) return;
    clearTimeout(this._telemetryTimer);
    this._telemetryTimer = null;
  }

  async _pollTelemetry() {
    // párhuzamosan: egy lassú robot ne húzza maga után a többit
    await Promise.all(
      [...this._robots.values()].map(async (entry) => {
        if (!entry.connected || !entry.client) return;
        // A mikrofon figyelése alatt az érzékelő-lekérések **szünetelnek**: a
        // routing nélküli firmware csak egy kérést szolgál ki egyszerre
        // (a válasz ~100 ms), így a kettő együtt torlasztaná egymást.
        // A felület a megmaradt értékeket stale jelöléssel mutatja.
        if (entry.micStreaming) return;
        // Ugyanez a szóló ritmusnál (Morse): a ritmus hangjai a rádiót foglalják,
        // és a lekérdezések csak a ritmus után indulnának el (a status timeoutolt).
        if (entry.client.isRhythmPlaying) return;
        // És egy folyamatban lévő felhasználói parancsnál: a routing nélküli
        // firmware eldobja a parancsot, ha egy kérés még folyamatban van —
        // a parancs kapja a rádiót, a szenzorok megvárják.
        if (entry.client.hasPendingAction) return;
        try {
          // minden érzékelő értékének megérkezésekor frissítjük a telemetriát:
          // a felület így nem a teljes lekérésre vár (a routing nélküli
          // generációban a szenzorok amúgy is sorban jönnek)
          await entry.client.status({
            onReading: (name, value) => {
              entry.telemetry = {
                ...(entry.telemetry || {}),
                [name]: value,
                updatedAt: Date.now(),
              };
              this.emit('telemetry', this.describe(entry.address));
            },
          });
        } catch {
          /* egy robot hibája ne szakítsa meg a többi telemetriát */
        }
      }),
    );
  }

  // --- mikrofon ---------------------------------------------------------

  /**
   * A mikrofon figyelésének indítása egy roboton.
   *
   * A robot mikrofonja nem hangot ad, hanem egy nyers erősségi értéket
   * (0..2048) — a felület ezt egy szintmérővel mutatja. A figyelés
   * bekapcsolásához a robotnak csatlakoztatva kell lennie.
   *
   * @param {string} address
   */
  startMicStream(address) {
    const key = normalizeAddress(address);
    const entry = this._robots.get(key);
    if (!entry || !entry.connected || !entry.client?.isConnected) {
      const error = new Error(`A ${key} robot nincs csatlakoztatva.`);
      error.status = 409;
      throw error;
    }
    if (entry.micTimer) return this.describe(key);
    entry.micStreaming = true;
    entry.micPeak = 0;

    let inFlight = false;
    const tick = async () => {
      // Egyszerre csak **egy** lekérdezés: a robot nem bírja a gyors egymás
      // utáni kéréseket (a válasz ~100 ms), és a sorban váró kérések minden
      // más lekérdezést (a telemetriát is) eltorlasztanának.
      if (inFlight) return;
      inFlight = true;
      try {
        if (!entry.client?.isConnected) return;
        const raw = await entry.client.mic();
        if (raw === null || raw === undefined) return;
        // ha közben leállították a figyelést, ne küldjünk több értéket
        if (!entry.micStreaming) return;
        const level = Math.min(100, Math.round((raw / MIC_FULL_SCALE) * 100));
        // a csúcs lassan ereszkedik (hogy lássuk a legutóbbi csúcsot is)
        entry.micPeak = Math.max(entry.micPeak * 0.85, level);
        this.emit('mic', {
          address: key,
          raw,
          level,
          peak: Math.round(entry.micPeak),
        });
      } catch {
        /* a BLE hiba nem állítja le a figyelést */
      } finally {
        inFlight = false;
      }
    };

    entry.micTimer = setInterval(() => {
      tick().catch(() => {
        /* a hiba a tick-ben kezelve van */
      });
    }, this._micMs);
    entry.micTimer.unref?.();
    tick().catch(() => {
      /* az első mérés hibája nem kritikus */
    });
    // a felület a szerver állapotával szinkronban tartja a gombot
    this.emit('robot', this.describe(key));
    return this.describe(key);
  }

  /** A mikrofon figyelésének leállítása. */
  stopMicStream(address) {
    const key = normalizeAddress(address);
    const entry = this._robots.get(key);
    if (!entry) return null;
    if (entry.micTimer) {
      clearInterval(entry.micTimer);
      entry.micTimer = null;
    }
    entry.micStreaming = false;
    this.emit('robot', this.describe(key));
    return this.describe(key);
  }

  // --- leírás ----------------------------------------------------------

  /** Nyilvános (JSON-barát) leírás a robotról. */
  describe(address) {
    const key = normalizeAddress(address);
    const entry = this._robots.get(key);
    if (!entry) {
      return {
        address: key,
        name: '',
        connected: false,
        seen: false,
        variant: null,
        reconnecting: false,
        telemetry: null,
      };
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
      /** A robot generációja: 'routing' | 'no-routing' (csatlakozás után derül ki). */
      variant: entry.variant ?? entry.client?.variant ?? null,
      /** Újracsatlakozás folyamatban (a kapcsolat váratlanul szakadt meg). */
      reconnecting: Boolean(entry.reconnecting),
      /** A mikrofon figyelése folyamatban. */
      micStreaming: Boolean(entry.micStreaming),
      telemetry: entry.telemetry ?? null,
    };
  }
}
