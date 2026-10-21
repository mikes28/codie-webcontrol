/**
 * CodieClient — egy robot BLE-kapcsolata.
 *
 * **Két Codie-generáció** létezik, eltérő wire-protokollal:
 *
 * | | routingos | routing nélküli |
 * |---|---|---|
 * | service | `52af0001-978a-628d-c845-0a104ca2b8dd` | `d46e7e53-ba2f-4044-ade9-f85ead45f458` |
 * | frame | `INFO(1) SEQ(2) CMD(2) ARGLEN(2) ARG…` | `SEQ(2) CMD(2) ARG…` |
 * | válasz | notify `52af0003` | két külön reply-karakterisztika |
 * | forrás | a repo Python `codie/protocol.py` | [zbettenbuk/codiejs](https://github.com/zbettenbuk/codiejs) |
 *
 * A kliens **automatikusan felismeri** a generációt a GATT-elrendezésből, és a
 * parancsréteg (`src/commands.js`) ugyanazt a parancskészletet látja mindkettőnél —
 * csak a frame-formátum és a skálák térnek el.
 */

'use strict';

import { EventEmitter } from 'node:events';

import * as p from './protocol.js';
import * as np from './protocol-norrouting.js';
import * as morse from '../morse.js';
import * as tunes from '../tunes.js';
import { normalizeAddress } from './noble.js';

/** Ennyi válasz-frame marad meg a kliensben (debug célra). */
const NOTIFICATION_HISTORY = 100;

/** Általános válasz-timeout (ms) egy parancs nyugtázásához. */
const RESPONSE_TIMEOUT_MS = 2500;

/**
 * A GATT-write időtartam-biztosítása.
 *
 * Ha a robot közben elalvik, a BlueZ write-ra nem jön vissza válasz — a write
 * végtelenül függne. A timeout nélküli write a teljes szervert lefagyaszthatná.
 */
const WRITE_TIMEOUT_MS = 3000;

/** A teljes állapotlekérés (4 érzékelő) legfeljebb ennyi ideig tarthat. */
const STATUS_TIMEOUT_MS = 10000;

/**
 * Egy érzékelő-kérés timeoutja.
 * Élőben mérve a robot ~100 ms alatt válaszol, szóval 1,2 s bőven elég —
 * és így egy elveszett kérés nem húzza el a teljes lekérést.
 */
const QUERY_TIMEOUT_MS = 1200;

/**
 * Kötelező szünet két BLE-üzenet között (ms).
 * A routing nélküli firmware a túl gyorsan következő üzenetet eldobja.
 * (Élőben mérve: 150 ms biztosan elég; a `CODIE_WRITE_GAP_MS` finomíthatja.)
 */
const MIN_WRITE_GAP_MS = 150;

/**
 * A **nyugtázatlan** (fire-and-forget) üzenetek közötti kötelező szünet (ms).
 *
 * Ezekre nem jön válasz, így csak a szünet védi őket: a routing nélküli
 * firmware a még feldolgozott üzenet után azonnal érkezőt eldobja. A nyugtázott
 * küldéseknél a válaszra való várakozás eleve betartja ezt a távolságot.
 */
const FIRE_AND_FORGET_GAP_MS = 150;

/** A csipogó alapfrekvenciája (a repo MEMORY.md-je szerint mérve: ~2483 Hz). */
const DEFAULT_BEEP_FREQUENCY = 2483;
const DEFAULT_BEEP_VOLUME = 100;

export class CodieClient extends EventEmitter {
  /**
   * @param {{address: string, noble: object, scanner: object, timeout?: number,
   *          scanWindow?: number, connectRetries?: number, retryDelay?: number,
   *          responseTimeout?: number}} options
   */
  constructor({
    address,
    noble,
    scanner,
    timeout = 20000,
    scanWindow = 8000,
    connectRetries = 3,
    retryDelay = 3000,
    responseTimeout = RESPONSE_TIMEOUT_MS,
    queryTimeout = QUERY_TIMEOUT_MS,
    writeTimeout = WRITE_TIMEOUT_MS,
    statusTimeout = STATUS_TIMEOUT_MS,
    writeGap = MIN_WRITE_GAP_MS,
  }) {
    super();
    this.address = normalizeAddress(address);
    /** A noble által használt cím-forma (kötőjel nélkül, kisbetűsen). */
    this._deviceId = this.address.replace(/:/g, '').toLowerCase();
    this.noble = noble;
    this.scanner = scanner;
    this._connectTimeout = timeout;
    this._scanWindow = scanWindow;
    this._connectRetries = Math.max(1, connectRetries);
    this._retryDelay = retryDelay;
    this._responseTimeout = responseTimeout;
    this._queryTimeout = queryTimeout;
    this._writeTimeout = writeTimeout;
    this._statusTimeout = statusTimeout;
    /** A kötelező szünet két BLE-üzenet között (ms). */
    this._writeGap = Math.max(0, writeGap);

    this._peripheral = null;
    /** A hirdetésből olvasott robotnév (a felületen így nem "(névtelen)" látszik). */
    this._advertisedName = '';
    /** A link állapota — a noble `peripheral.state` csak a connect után áll be,
     *  ezért nem szabad rá építeni (versenyhelyzet lenne). */
    this._connected = false;
    this._variant = null; // 'routing' | 'no-routing'
    this._pending = new Map(); // routing: seq -> resolver
    this._queryPending = new Map(); // routing nélküli: seq -> resolver
    this._actionPending = new Map();
    /** Kérés-sorok: a firmware eldobja a túl gyorsan következő üzenetet. */
    this._queryChain = Promise.resolve();
    this._actionChain = Promise.resolve();
    /** A szóló ritmus mélysége (> 0 = most megy a Morse / beépített minta). */
    this._rhythmDepth = 0;
    /** A folyamatban lévő felhasználói parancsok száma (a lekérdezések várólistája). */
    this._actionDepth = 0;
    /** Az utolsó BLE-üzenet időbélyege — a kötelező szünet kiszámításához. */
    this._lastWriteAt = 0;
    this._seq = 0;
    this.notifications = [];
    /**
     * A feliratkozott karakterisztika-listener-ek (cél, esemény, handler).
     *
     * A noble **cache-eli** a karakterisztikákat, így egy újracsatlakozás
     * ugyanarra a példányra kötne új 'data' listenert — a listener-ek
     * halmozódnának (a Node a 10. fölött figyelmeztet), és minden notify-t
     * minden régi kliens feldolgozná. Ezért a saját listener-ünket a
     * takarításkor levesszük.
     */
    this._listeners = [];
    /** A peripheral 'disconnect' handlerje — külön tárolva, mert a kapcsolat
     *  életideje hosszabb a karakterisztika-listener-ekénél. */
    this._peripheralDisconnectHandler = null;
    this._disconnectedEmitted = false;

    // Az EventEmitter 'error' eseménye listener nélkül **dobja** az exceptiont —
    // egy hibás BLE-csomag így az egész szervert (a webes felületet) megölte
    // volna. A hiba ezért 'ble-error' néven továbbítódik: az nem dob, hanem a
    // registry (és általa a UI) figyelheti.
    this.on('error', (error) => this.emit('ble-error', error));
  }

  /** A felismerett generáció: 'routing' | 'no-routing' | null (még nincs csatlakozva). */
  get variant() {
    return this._variant;
  }

  // --- BLE-listener-ek --------------------------------------------------

  /**
   * Feliratkozás egy BLE-eseményre — a takarításkor a saját listener-ünket
   * vesszük le (a noble cache-elt objektumainál a listener halmozódna).
   * @param {object} target
   * @param {string} event
   * @param {Function} handler
   */
  _listen(target, event, handler) {
    target.on(event, handler);
    this._listeners.push({ target, event, handler });
  }

  /** A karakterisztika-listener-ek levéteele (új feliratkozás előtt). */
  _unlistenCharacteristics() {
    for (const { target, event, handler } of this._listeners.splice(0)) {
      try {
        target.removeListener(event, handler);
      } catch {
        /* a takarítás nem kritikus */
      }
    }
  }

  /**
   * Minden saját BLE-listener levéteele (a kapcsolat megszakadásakor).
   * @param {object|null} [peripheral] a peripheral, amiről a listenert le kell venni
   */
  _unlistenAll(peripheral = this._peripheral) {
    this._unlistenCharacteristics();
    if (this._peripheralDisconnectHandler) {
      const handler = this._peripheralDisconnectHandler;
      this._peripheralDisconnectHandler = null;
      try {
        peripheral?.removeListener('disconnect', handler);
      } catch {
        /* a takarítás nem kritikus */
      }
    }
  }

  // --- életciklus ------------------------------------------------------

  /**
   * Csatlakozás retry-jal + felébresztő scannel.
   *
   * A Python `codie/client.py` `connect()` függvényének 1:1 portja: ugyanaz a
   * retry-ciklus, ugyanaz a `_scan_wake()` a próbálkozások között, ugyanaz a
   * részleges állapot takarítása.
   *
   * A Codie egy idő után elalszik; ilyenkor az első connect timeoutol. Egy BLE-scan
   * felébreszti / újrafelfedezteti a BlueZ-vel, majd újrapróbálkozunk — így egy elalvás
   * nem bukik el tévedésből.
   */
  async connect() {
    let lastError = null;
    for (let attempt = 1; attempt <= this._connectRetries; attempt += 1) {
      try {
        await this._connectOnce();
        this.emit('connected', this.address);
        return this;
      } catch (error) {
        lastError = error;
        this.emit('connect-error', this.address, error);
        await this._cleanupPartial();
        if (attempt < this._connectRetries) {
          await this._scanWake();
          await sleep(this._retryDelay);
        }
      }
    }
    throw lastError;
  }

  /**
   * Egy connect-próba: felébresztő scan, majd csatlakozás **cím** alapján.
   *
   * A bleak (a Python kliensben) a BlueZ device-path alapján csatlakozik, és a
   * háttérben újrapróbálkozik. A noble-nál a címet kell átadni, és a feloldást a
   * felébresztő scan végzi (ő tölti be a BlueZ-be és a noble modellbe is).
   */
  async _connectOnce() {
    await this._scanWake();

    // A BlueZ "In Progress" hibája azt jelenti, hogy már fut egy csatlakozási
    // kísérlet (egy korábbi, megszakadt connect maradt a háttérben) — ezt
    // meg kell várni, nem pedig hibaként kezelni (különben a connect azonnal
    // elhasal, és a felület "nem érhető el" hibát mutat).
    let peripheral = null;
    let lastError = null;
    for (let attempt = 1; attempt <= 3 && !peripheral; attempt += 1) {
      try {
        peripheral = await withTimeout(
          this.noble.connectAsync(this._deviceId),
          this._connectTimeout,
          `connect timeout (${this._connectTimeout} ms) — a ${this.address} robot nem válaszol`,
        );
      } catch (error) {
        lastError = error;
        if (!isConnectInProgress(error)) throw error;
        // A BlueZ maga is próbál csatlakozni (a korábbi kísérlet maradványa):
        // megvárjuk, amíg az befejeződik — közben akár sikerül is neki.
        await sleep(5000);
      }
    }
    if (!peripheral) {
      if (lastError) throw lastError;
      throw new Error(
        `A ${this.address} robotot a BlueZ még nem ismeri (a connect nem adott vissza peripheral-t) — a felébresztő scan nem találta.`,
      );
    }

    this._peripheral = peripheral;
    this._connected = true;
    this._disconnectedEmitted = false;
    // A 'disconnect' esemény a link megszakadását jelzi. A listener a
    // **sajátunk** — a noble cache-eli a peripheral-t, ezért minden
    // újracsatlakozás új listenert kötne rá (a Node a 10. fölött figyelmeztet),
    // és egy BLE-drop duplán jelezne. A takarítás leveszi.
    this._peripheralDisconnectHandler = () => this._handleDisconnect();
    peripheral.on('disconnect', this._peripheralDisconnectHandler);

    await this._setup(peripheral);
  }

  /**
   * Best-effort felébresztő/discovery scan a sikertelen connect után
   * (a Python kliens `_scan_wake()` függvényének megfelelően).
   */
  async _scanWake() {
    try {
      const peripheral = await this.scanner.wakeScan(this.address, {
        durationMs: this._scanWindow,
      });
      // a hirdetésből a robot neve — a felületen így nem "(névtelen)" látszik
      const advertised = peripheral?.advertisement?.localName || peripheral?.name;
      if (advertised) this._advertisedName = String(advertised);
    } catch {
      /* a scan best-effort, a lényeg a retry */
    }
  }

  /** A hirdetésből olvasott robotnév (üres, ha még nem hirdetett). */
  get advertisedName() {
    return this._advertisedName || '';
  }

  /** Most szól a ritmus (Morse / beépített minta)? */
  get isRhythmPlaying() {
    return this._rhythmDepth > 0;
  }

  /**
   * A link állapota — a saját flagünk az igazság forrása.
   *
   * A noble `peripheral.state` csak a binding 'connect' eseményének feldolgozása után
   * lesz 'connected' — tehát a connect promise feloldása **után** még 'connecting'
   * lehet. Ezért nem szabad rá építeni (versenyhelyzet lenne).
   */
  get linkIsUp() {
    return this._connected;
  }

  async _cleanupPartial() {
    const peripheral = this._peripheral;
    this._peripheral = null;
    this._connected = false;
    // A BLE-listener-ek lekéte: a noble cache-eli a karakterisztikákat, így a
    // régi 'data' handlerek az új kapcsolat üzeneteit is feldolgoznák.
    this._unlistenAll(peripheral);
    // a függőben lévő kéréseknek nem jön válasz (a link megszakadt)
    this._clearPending();
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
    await this._cleanupPartial();
    this._emitDisconnected();
  }

  get isConnected() {
    return Boolean(this._connected && this._peripheral);
  }

  _handleDisconnect() {
    const peripheral = this._peripheral;
    this._peripheral = null;
    this._connected = false;
    // a link megszakadt → a saját BLE-listener-ek már stale-ek
    this._unlistenAll(peripheral);
    this._clearPending();
    this._emitDisconnected();
  }

  /** A függőben lévő kérések nullra oldása (a válasz már nem jön). */
  _clearPending() {
    for (const map of [this._pending, this._queryPending, this._actionPending]) {
      for (const [, resolver] of map) resolver(null);
      map.clear();
    }
  }

  /** Egy lekapcsolódás = egy esemény (a tisztítás és a BLE esemény ne duplikáljon). */
  _emitDisconnected() {
    if (this._disconnectedEmitted) return;
    this._disconnectedEmitted = true;
    this.emit('disconnected', this.address);
  }

  /** A válaszok beérkezési naplója (korlátolt). */
  _recordNotification(raw) {
    this.notifications.push({ raw });
    if (this.notifications.length > NOTIFICATION_HISTORY) {
      this.notifications.splice(0, this.notifications.length - NOTIFICATION_HISTORY);
    }
  }

  // --- beállítás (a generáció felismerése) ------------------------------

  /**
   * Felismeri a generációt a GATT-elrendezésből, és feliratkozik a válasz-csatornákra.
   */
  async _setup(peripheral) {
    const deadline = Date.now() + this._connectTimeout;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        // egy korábbi iteráció (pl. a subscribe hibája) már feliratkozott —
        // a stale handlerek ne maradjanak rajta a karakterisztikán
        this._unlistenCharacteristics();
        const { characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();
        const find = (uuid) => characteristics.find((c) => p.sameUuid(c.uuid, uuid));

        const routingWrite = find(p.WRITE_UUID);
        if (routingWrite) {
          this._variant = 'routing';
          this._writeChar = routingWrite;
          this._notifyChar = find(p.NOTIFY_UUID);
          if (this._notifyChar) {
            this._listen(this._notifyChar, 'data', (data) => this._onRoutingNotify(data));
            await this._notifyChar.subscribeAsync();
          }
          return;
        }

        const requestChar = find(np.REQUEST_UUID);
        const actionChar = find(np.ACTION_UUID);
        if (requestChar && actionChar) {
          this._variant = 'no-routing';
          this._requestChar = requestChar;
          this._actionChar = actionChar;
          this._requestReplyChar = find(np.REQUEST_REPLY_UUID);
          this._actionReplyChar = find(np.ACTION_REPLY_UUID);
          if (this._requestReplyChar) {
            this._listen(this._requestReplyChar, 'data', (data) => this._onNoRoutingReply(data, 'query'));
            await this._requestReplyChar.subscribeAsync();
          }
          if (this._actionReplyChar) {
            this._listen(this._actionReplyChar, 'data', (data) => this._onNoRoutingReply(data, 'action'));
            await this._actionReplyChar.subscribeAsync();
          }
          // A firmware az első üzenetet nem mindig nyugtázza, és a túl gyorsan
          // következőt el is dobja — ezért a beállításkor elküldünk egy echo-t
          // és egy értéktelen lekérdezést. Így az első é valódi kérés mindig
          // választ kap.
          await this._writeGatt(this._actionChar, np.buildFrame(np.CMD_ECHO, [], this._nextSeq()));
          await this._sendQuery(np.QUERY_BATTERY, { timeout: 800 }).catch(() => null);
          return;
        }

        lastError = new Error(
          `Ismeretlen Codie GATT-elrendezés a ${this.address} roboton (sem a routingos, sem a routing nélküli karakterisztikák nem találhatók).`,
        );
      } catch (error) {
        lastError = error;
      }
      await sleep(500);
    }
    throw lastError || new Error('A GATT szolgáltatás nem oldódott fel.');
  }

  // --- routingos generáció ---------------------------------------------

  /**
   * GATT-write időtartam-biztosítva + kötelező szünet két üzenet között.
   *
   * Ha a robot közben elalvik, a BlueZ write-ra nem jön válasz — a write
   * végtelenül függne, és az egész szervert lefagyasztaná.
   *
   * A szünet azért kell, mert a routing nélküli firmware **eldobja** az
   * üzenetet, ha rögtön utána jön a következő: élőben mérve az azonnal
   * küldött kérésekből az első mindig elveszett, 150 ms szünet után viszont
   * mindegyikre jött válasz.
   */
  async _writeGatt(char, frame, { minGap = this._writeGap } = {}) {
    // A slotot **szinkron** foglaljuk (a sleep előtt), különben a lekérdezési és
    // az akciósor (két külön lánc!) ugyanabban a milliszekundban írhatna ki két
    // üzenetet — és a firmware azonnal eldobja az egyiket.
    //
    // A kötelező szünet csak a **routing nélküli** firmware-re vonatkozik: a
    // routingos generáció a párhuzamos kéréseket SEQ-vel párosítja, ott a
    // szünet csak lassítaná a lekérést.
    const gap = this._variant === 'no-routing' ? minGap : 0;
    const now = Date.now();
    const start = Math.max(now, this._lastWriteAt + gap);
    this._lastWriteAt = start;
    if (start > now) await sleep(start - now);
    await withTimeout(
      char.writeAsync(frame, true),
      this._writeTimeout,
      `BLE write timeout (${this._writeTimeout} ms) — a robot nem válaszol`,
    );
  }

  _onRoutingNotify(data) {
    if (!data) return; // hibás olvasás → null adat
    try {
      const raw = Buffer.from(data);
      const resp = p.decodeResponse(raw);
      this._recordNotification(raw);
      if (resp) {
        const resolver = this._pending.get(resp.reqSeq);
        if (resolver) {
          this._pending.delete(resp.reqSeq);
          resolver(resp);
        }
      }
    } catch (error) {
      // egy hibás csomag ne öljön meg sem a klienset, sem a szervert
      this.emit('error', error);
    }
  }

  /**
   * Parancs küldése a write karakterisztikára (routingos generáció).
   * @returns {Promise<object|null>} a dekódolt válasz, vagy null (timeout/nincs nyugta)
   */
  async send(cmdId, args = Buffer.alloc(0), { expectResponse = true, timeout = this._responseTimeout } = {}) {
    if (!this._writeChar) {
      throw new Error('Nincs kapcsolat — hívd előbb a connect()-et.');
    }
    const { frame, seq } = p.buildFrame(cmdId, args);
    if (!expectResponse) {
      await this._writeGatt(this._writeChar, frame, { minGap: FIRE_AND_FORGET_GAP_MS });
      return { sent: true, acknowledged: false };
    }
    let resolver = null;
    const promise = new Promise((resolve) => {
      resolver = resolve;
    });
    this._pending.set(seq, resolver);
    const timer = setTimeout(() => {
      if (this._pending.delete(seq)) resolver(null);
    }, timeout);
    try {
      await this._writeGatt(this._writeChar, frame);
      return await promise;
    } finally {
      // a write hibája esetén is takarítunk, hogy a _pending ne szivárgasson
      clearTimeout(timer);
      this._pending.delete(seq);
    }
  }

  // --- routing nélküli generáció -----------------------------------------

  _nextSeq() {
    this._seq = (this._seq + 1) & 0xffff;
    return this._seq;
  }

  _onNoRoutingReply(data, kind) {
    // A BlueZ egy hibás olvasásnál null adatot adhat — a handler ne álljon meg ettől.
    if (!data) return;
    try {
      const raw = Buffer.from(data);
      this._recordNotification(raw);
      const reply = np.decodeReply(raw);
      if (!reply) return;
      const pending = kind === 'query' ? this._queryPending : this._actionPending;
      const resolver = pending.get(reply.seq);
      if (resolver) {
        pending.delete(reply.seq);
        resolver(reply);
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  /**
   * Egy művelet kéréssorba állítása.
   *
   * A routing nélküli firmware **eldobja** az üzenetet, ha rögtön utána jön
   * egy másik: élőben mérve a négy párhuzamos érzékelő-kérésből csak az utolsó
   * válaszolt (a sorban küldve mindegyikre jön válasz). Ezért az érzékelő-
   * kérések és az akciók is külön sorban futnak.
   */
  _enqueue(kind, task) {
    const key = kind === 'query' ? '_queryChain' : '_actionChain';
    const previous = this[key];
    let release;
    this[key] = new Promise((resolve) => {
      release = resolve;
    });
    if (kind === 'action') this._actionDepth += 1;
    const run = () =>
      Promise.resolve(task()).finally(() => {
        if (kind === 'action') this._actionDepth -= 1;
        release();
      });
    return previous.then(run, run);
  }

  /**
   * Van-e folyamatban lévő (vagy sorban álló) felhasználói parancs?
   *
   * A routing nélküli firmware eldobja a parancsot, ha egy kérés még
   * folyamatban van — a lekérdezések (a telemetria-poll) ezért megvárják a
   * parancs végét, különben a felhasználói parancsok néha elvesznek.
   */
  get hasPendingAction() {
    return this._actionDepth > 0;
  }

  /**
   * Megvárja, hogy a lekérdezések lefussonak.
   *
   * A routing nélküli firmware eldobja az üzenetet, ha egy kérés még
   * folyamatban van: élőben mérve a telemetria-poll (5 mp) alatt küldött
   * parancsok kb. 7%-a elveszett — a parancs most megvárja a lekérdezéseket.
   *
   * A várakozás korlátolt, hogy egy elakadó robot ne tegye lógóvá a
   * felületet: a határon a parancs akkor is kimegy (és ha eldobja, a felület
   * hibát jelez — nem hamis "OK"-t).
   *
   * @param {number} maxWaitMs legfeljebb ennyit vár (a ciklus a határon kilép)
   */
  async _waitForIdleQueries(maxWaitMs = 3000) {
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const chain = this._queryChain;
      await chain.catch(() => {
        /* a lekérdezés hibája nem számít */
      });
      // ha közben indult új lekérdezés, a lánc megváltozott — várunk tovább
      if (chain === this._queryChain) return;
    }
  }

  /**
   * Megvárja, hogy a futó ritmus (Morse / beépített minta) befejeződjen.
   *
   * A ritmus alatt nem küldünk lekérdezést: a firmware a szóló ritmus közben
   * eldobná a kérést (és a ritmus egyik hangját is eldobhatná).
   */
  async _waitForRhythm(maxWaitMs = 5000) {
    const deadline = Date.now() + maxWaitMs;
    while (this._rhythmDepth > 0 && Date.now() < deadline) {
      await sleep(50);
    }
  }

  /**
   * Parancs (beep, LED, motor) az action karakterisztikára.
   *
   * Az `internal: true` a **ritmus saját** hangjait jelöli: ezeket nem
   * szabad a lekérdezésekre vártatni (az deadlock lenne), és a felhasználói
   * parancsok sem szúródhatnak közéjük — azok a ritmus **végére** várnak.
   */
  async _sendAction(
    cmd,
    params = [],
    { expectResponse = true, timeout = this._responseTimeout, internal = false } = {},
  ) {
    return this._enqueue('action', async () => {
      if (internal) {
        // a ritmus hangja: azonnal kimegy (a firmware a ritmust dolgozza)
        return this._sendActionNow(cmd, params, { expectResponse, timeout });
      }
      // Először a futó ritmus végére várunk (a felhasználói parancs ne
      // csúrjon a Morse közepébe), utána a futó lekérdezésekre.
      await this._waitForRhythm();
      await this._waitForIdleQueries();
      return this._sendActionNow(cmd, params, { expectResponse, timeout });
    });
  }

  async _sendActionNow(cmd, params = [], { expectResponse = true, timeout = this._responseTimeout } = {}) {
    if (!this._actionChar) throw new Error('Nincs kapcsolat — hívd előbb a connect()-et.');
    const seq = this._nextSeq();
    const frame = np.buildFrame(cmd, params, seq);
    // Ha a roboton nincs ACTION_REPLY karakterisztika, nyugta nem jöhet:
    // fire-and-forget módban küldünk (a parancsréteg így nem vár hiába választ).
    const canAck = this._variant !== 'no-routing' || Boolean(this._actionReplyChar);
    if (!expectResponse || !canAck) {
      await this._writeGatt(this._actionChar, frame, { minGap: FIRE_AND_FORGET_GAP_MS });
      return { sent: true, acknowledged: false };
    }
    let resolver = null;
    const promise = new Promise((resolve) => {
      resolver = resolve;
    });
    this._actionPending.set(seq, resolver);
    const timer = setTimeout(() => {
      if (this._actionPending.delete(seq)) resolver(null);
    }, timeout);
    try {
      await this._writeGatt(this._actionChar, frame);
      return await promise;
    } finally {
      clearTimeout(timer);
      this._actionPending.delete(seq);
    }
  }

  /** Érzékelő-kérés a request karakterisztikára (sorban, egyenként). */
  async _sendQuery(cmd, { timeout = this._queryTimeout } = {}) {
    return this._enqueue('query', async () => {
      // egy futó ritmus közben nem küldünk lekérdezést (a firmware eldobná)
      await this._waitForRhythm();
      return this._sendQueryNow(cmd, { timeout });
    });
  }

  /**
   * Egy érzékelő-kérés — a firmware néha eldob egy üzenetet (főleg ébredés
   * után), ezért egyszer újrapróbáljuk egy új sorszámmal.
   */
  async _sendQueryNow(cmd, { timeout = this._queryTimeout } = {}) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const reply = await this._queryOnce(cmd, { timeout });
      if (reply) return reply;
    }
    return null;
  }

  async _queryOnce(cmd, { timeout = this._queryTimeout } = {}) {
    if (!this._requestChar) throw new Error('Nincs kapcsolat — hívd előbb a connect()-et.');
    const seq = this._nextSeq();
    const frame = np.buildFrame(cmd, [], seq);
    let resolver = null;
    const promise = new Promise((resolve) => {
      resolver = resolve;
    });
    this._queryPending.set(seq, resolver);
    const timer = setTimeout(() => {
      if (this._queryPending.delete(seq)) resolver(null);
    }, timeout);
    try {
      await this._writeGatt(this._requestChar, frame);
      const reply = await promise;
      if (reply) return reply;
      // tartalék: a válasz-karakterisztika olvasható is — olvassuk ki a legutóbbit
      return await this._readRequestReply(seq);
    } finally {
      clearTimeout(timer);
      this._queryPending.delete(seq);
    }
  }

  async _readRequestReply(seq) {
    if (!this._requestReplyChar) return null;
    try {
      const value = await withTimeout(this._requestReplyChar.readAsync(), 1000, 'read timeout');
      const reply = np.decodeReply(value);
      if (!reply || reply.seq !== seq) return null;
      return reply;
    } catch {
      return null;
    }
  }

  /**
   * A LED-szín átvitele a routing nélküli firmware skálájára.
   * A codiejs szerint: hue 0-360 (×0,7 → 0-252), sat/val 0-100 (×2,55 → 0-255).
   * A mi színtáblánk HSV 0-255, ezért onnan visszaszámolunk.
   *
   * A telítettségnél és az értéknél `Math.round` kell (nem `floor`): a
   * 100 × 2,55 float-értéke 254,99999999999997, így a floor 254-et adna
   * a helyes 255 helyett (a `red` szín sat/val értéke pont 255).
   */
  _colorParams(color) {
    const [h, s, v] = p.colorHsv(color);
    return [
      Math.floor((h / 255) * 360 * 0.7) & 0xff,
      Math.round((s / 255) * 100 * 2.55) & 0xff,
      Math.round((v / 255) * 100 * 2.55) & 0xff,
    ];
  }

  // --- aktuátorok (generációfüggetlen API) -----------------------------

  /**
   * Csipogás.
   * @param {number} durationMs
   * @param {{volume?: number, frequency?: number, expectResponse?: boolean, internal?: boolean}} options
   *   `internal: true` → a ritmus saját hangja (nem vár a lekérdezésekre).
   */
  async beep(
    durationMs = 1000,
    {
      volume = DEFAULT_BEEP_VOLUME,
      frequency = DEFAULT_BEEP_FREQUENCY,
      expectResponse = true,
      internal = false,
    } = {},
  ) {
    if (this._variant === 'no-routing') {
      const duration = Math.max(0, Math.min(Math.trunc(durationMs), np.MAX_BEEP_MS));
      return this._sendAction(
        np.CMD_BEEP,
        [Math.trunc(volume) & 0xff, ...np.u16(Math.trunc(frequency)), ...np.u16(duration)],
        { expectResponse, internal },
      );
    }
    return this.send(p.CMD_SPEAK_BEEP, p.beepArgs(durationMs), { expectResponse });
  }

  /**
   * Ritmusminta lejátszása: [[csipogás_ms, szünet_ms], ...].
   * Fire-and-forget beepek, a ritmust lokális várakozás adja.
   *
   * A ritmus alatt a firmware eldobná a beérkező lekérdezéseket (és azok
   * viszont a ritmus egyik hangját) — ezért a ritmus megjelöli a szóló
   * ablakot, és a lekérdezések megvárják a végét.
   */
  async playRhythm(pattern) {
    // indulás előtt megvárjuk a futó lekérdezéseket (még nincs ritmus-jelölve)
    await this._waitForIdleQueries(1500);
    this._rhythmDepth += 1;
    try {
      for (const [beepMs, gapMs] of pattern) {
        const started = Date.now();
        await this.beep(Math.trunc(beepMs), { expectResponse: false, internal: true });
        // A `sleep` ezredmásodpercet vár — a Python-os `asyncio.sleep` másodpercet vár,
        // ezért itt NEM osztunk 1000-rel. A kivárt küldés idejét levágjuk, hogy
        // a ritmus pontos maradjon (a write-szünet ne húzza el).
        const elapsed = Date.now() - started;
        await sleep(Math.max(0, beepMs + gapMs - elapsed));
      }
    } finally {
      this._rhythmDepth -= 1;
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
    if (this._variant === 'no-routing') {
      return this._sendAction(np.CMD_SET_COLOR, this._colorParams(color));
    }
    return this.send(p.CMD_LED_SET_COLOR, p.ledAllArgs(color));
  }

  async ledSingle(color, index) {
    if (this._variant === 'no-routing') {
      // Ebben a generációban nincs egyedi LED-címzés — az összes LED színeződik.
      return this.ledAll(color);
    }
    return this.send(p.CMD_LED_SET_COLOR, p.ledSingleArgs(color, index));
  }

  /** "kikapcsolt" = value 0 (fekete) */
  async ledsOff() {
    if (this._variant === 'no-routing') {
      return this._sendAction(np.CMD_SET_COLOR, [0, 0, 0]);
    }
    return this.send(p.CMD_LED_SET_COLOR, Buffer.concat([p.u16(0x0fff), p.u8(0), p.u8(0), p.u8(0)]));
  }

  /**
   * Beépített LED-animáció (a routing nélküli generációban).
   *
   * A codiejs referencia: `setAnimation(animation, hue, saturation, repeat, speed)`,
   * ahol az animáció sorszáma **0 vagy 1** (*"Possible animation values: 0, 1"*).
   * A színt a firmware skálájában adjuk át — ugyanazzal a számítással, mint a
   * `setColor` parancsnál (hue 0-360 ×0,7; sat 0-100 ×2,55).
   *
   * A `repeat` és a `speed` firmware-szemantikája nem dokumentált → a hívó
   * próbálgathatja őket (a parancsréteg átadja őket változtatás nélkül).
   *
   * @param {number} animation a beépített animáció sorszáma (0 vagy 1)
   * @param {{color?: string, repeat?: number, speed?: number}} options
   */
  async ledAnimation(animation, { color = 'red', repeat = 0, speed = 10 } = {}) {
    if (this._variant !== 'no-routing') {
      const error = new Error(
        'A LED-animáció a routing nélküli generációban érhető el — a routingos ' +
          'firmware animáció-parancsának (0x1066) paraméterei nem dokumentáltak.',
      );
      error.status = 501; // Not Implemented: ezen a generáción nincs ismert megvalósítás
      throw error;
    }
    const [hue, sat] = this._colorParams(color);
    return this._sendAction(np.CMD_SET_ANIMATION, [
      animation & 0xff,
      hue,
      sat,
      repeat & 0xff,
      speed & 0xff,
    ]);
  }

  async driveSpeed(left, right) {
    if (this._variant === 'no-routing') {
      return this._sendAction(np.CMD_MOTOR_BOTH, [left & 0xff, right & 0xff]);
    }
    return this.send(p.CMD_DRIVE_SPEED, p.driveSpeedArgs(left, right));
  }

  async stop() {
    return this.driveSpeed(0, 0);
  }

  async driveDistance(distanceMm, left = 30, right = 30) {
    if (this._variant === 'no-routing') {
      return this._sendAction(np.CMD_MOVE, [...np.u16(Math.trunc(distanceMm)), left & 0xff, right & 0xff]);
    }
    return this.send(p.CMD_DRIVE_DISTANCE, p.driveDistanceArgs(distanceMm, left, right));
  }

  async driveTurn(degree, speed = 30) {
    if (this._variant === 'no-routing') {
      return this._sendAction(np.CMD_TURN, [...np.u16(Math.trunc(degree)), speed & 0xff]);
    }
    return this.send(p.CMD_DRIVE_TURN, p.driveTurnArgs(degree, speed));
  }

  // --- szenzorok (generációfüggetlen API) -------------------------------

  async battery() {
    if (this._variant === 'no-routing') {
      const reply = await this._sendQuery(np.QUERY_BATTERY);
      return reply && reply.value !== null ? np.normalizeBattery(reply.value) : null;
    }
    const r = await this.send(p.CMD_BATTERY);
    return r ? p.readU8(r.args, 0) : null;
  }

  async light() {
    if (this._variant === 'no-routing') {
      // a firmware a nyers 12 bites értéket adja (nagyobb = sötétebb) — a
      // routingos generációval azonos skálán adjuk vissza
      const reply = await this._sendQuery(np.QUERY_LIGHT);
      return reply ? reply.value : null;
    }
    const r = await this.send(p.CMD_LIGHT);
    return r ? p.readU16(r.args, 0) : null;
  }

  async line() {
    if (this._variant === 'no-routing') {
      const reply = await this._sendQuery(np.QUERY_LINE);
      if (!reply) return null;
      // Ebben a generációban NINCS két érzékelő: egyetlen 32 bites, fix-pontos
      // érték jön (élőben mérve 60 mintában mindig 0x05xx07yy volt a mintázat).
      // A codiejs referencia 2^20-zal osztja, és 30 felett „vonalt követ”-nek
      // tekinti — ezt a normalizálást követhetjük.
      return np.decodeLine(reply.payload);
    }
    const r = await this.send(p.CMD_LINE);
    if (!r) return null;
    return { left: p.readU16(r.args, 0), right: p.readU16(r.args, 2) };
  }

  async sonar() {
    if (this._variant === 'no-routing') {
      const reply = await this._sendQuery(np.QUERY_DISTANCE);
      return reply && reply.value !== null ? np.normalizeDistance(reply.value) : null;
    }
    const r = await this.send(p.CMD_SONAR);
    return r ? p.readU16(r.args, 0) : null;
  }

  async mic() {
    if (this._variant === 'no-routing') {
      // a nyers érték (a routingos generációval azonos skála)
      const reply = await this._sendQuery(np.QUERY_SOUND);
      return reply ? reply.value : null;
    }
    const r = await this.send(p.CMD_MIC);
    return r ? p.readU16(r.args, 0) : null;
  }

  async batteryVoltage() {
    if (this._variant === 'no-routing') return null; // nincs ilyen parancs
    const r = await this.send(p.CMD_BATTERY_VOLTAGE);
    return r ? p.readU16(r.args, 0) : null;
  }

  /**
   * A robot pillanatnyi állapota — egy csomagban minden szenzor.
   *
   * A feszültség (`BatteryGetVoltage`) a routingos firmware-en **nem válaszol**, ezért
   * nincs benne: egy válasz-timeout (2,5 mp) minden telemetria-körbe kerülne.
   *
   * Az `onReading` callback **minden érzékelő megérkezésekor** meghívódik, így a
   * felület nem a teljes lekérésre vár: a routing nélküli generációban a
   * firmware eldobja az átfedő kéréseket, ezért a szenzorok sorban jönnek —
   * a felület így érzékelőnként frissül (~100 msenként).
   *
   * @param {{onReading?: (name: string, value: unknown) => void}} options
   */
  async status({ onReading } = {}) {
    // egy érzékelő hibája ne rontsa el a teljes lekérést
    let aborted = false;
    const safe = async (name, read) => {
      let value = null;
      try {
        value = await read();
      } catch {
        value = null;
      }
      // a lejárt kör értékeit nem szabad továbbadni (a felület „frissnek”
      // jelölne olyan adatot, ami már egy régebbi mérésből származik)
      if (onReading && !aborted) onReading(name, value);
      return value;
    };
    const readings = Promise.all([
      safe('batteryPct', () => this.battery()),
      safe('sonarMm', () => this.sonar()),
      safe('lightRaw', () => this.light()),
      safe('line', () => this.line()),
    ]);
    try {
      const [batteryPct, sonarMm, lightRaw, line] = await withTimeout(
        readings,
        this._statusTimeout,
        `a szenzor-lekérés timeoutolt (${this._statusTimeout} ms)`,
      );
      return { batteryPct, sonarMm, lightRaw, line };
    } catch (error) {
      aborted = true;
      throw error;
    }
  }

  // --- protokoll-jelzések (hivatalos SDK, csak routingos) ---------------

  async appConnected() {
    if (this._variant === 'no-routing') return null;
    return this.send(p.CMD_APP_CONNECTED);
  }

  async appDisconnected() {
    if (this._variant === 'no-routing') return null;
    return this.send(p.CMD_APP_DISCONNECTED);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A BlueZ "In Progress" hibája: már fut egy csatlakozási kísérlet.
 * (Egy korábbi, megszakadt connect maradhat a háttérben — pl. a szerver
 * újraindítása után.)
 */
export function isConnectInProgress(error) {
  if (!error) return false;
  const type = String(error.type || '');
  const text = String(error.text || error.message || '');
  return type.includes('InProgress') || text.includes('In Progress');
}

export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
