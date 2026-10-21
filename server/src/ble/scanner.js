/**
 * Robot-felderítés (scan) — kizárólag a Codie robotokat mutatja.
 *
 * A környezet tele van más BLE eszközökkel (fehallgatók, telefonok, fitnesz
 * karikák). A szűrő két "identity" jelet használ:
 *
 *   1. név      — a Codie hirdetett neve ("Codie"); a szűrő prefix-alapú,
 *                 így több robot ("Codie", "Codie 2") is illeszkedik;
 *   2. UUID     — a robot által hirdetett service UUID-k.
 *
 * Opcionális MAC-allowlist szűkíti tovább a halmazt (a felhasználó kérése):
 *   - `macAllowlist` nem üres → a címnek benne kell lennie;
 *   - `macOnly` = true → az allowlist önmagában is elfogad (név/UUID nélkül).
 */

'use strict';

import { normalizeAddress } from './noble.js';
import * as p from './protocol.js';

/** A BLE discovery indítás/leállítás időtartam-biztosítása. */
const DISCOVERY_TIMEOUT_MS = 8000;

/**
 * Tiszta szűrőfüggvény — egységesen tesztelhető.
 * @param {{address?: string, name?: string, serviceUuids?: string[]}} advertisement
 * @param {{nameFilter?: string, serviceUuids?: string[], macAllowlist?: string[], macOnly?: boolean}} filters
 * @returns {{match: boolean, reasons: string[]}}
 */
export function matchRobot(advertisement, filters = {}) {
  const reasons = [];
  const name = (advertisement.name || '').trim();
  const nameFilter = (filters.nameFilter || '').trim().toLowerCase();
  const address = normalizeAddress(advertisement.address || '');
  const allowlist = (filters.macAllowlist || []).map(normalizeAddress);
  const uuids = (advertisement.serviceUuids || []).map(p.canonicalUuid);
  const wantedUuids = (filters.serviceUuids || []).map(p.canonicalUuid);

  const nameMatched = Boolean(nameFilter) && name.toLowerCase().startsWith(nameFilter);
  const uuidMatched = wantedUuids.some((wanted) => uuids.includes(wanted));

  if (nameMatched) reasons.push('name');
  if (uuidMatched) reasons.push('service-uuid');

  const allowlisted = allowlist.includes(address);
  if (filters.macOnly) {
    // MAC-only módban **csak** az allowlist számít: üres allowlistnál egy sem megy át.
    if (allowlisted) reasons.push('allowlisted');
    return { match: allowlisted, reasons };
  }
  if (allowlist.length > 0 && !allowlisted) {
    return { match: false, reasons: ['not-allowlisted'] };
  }
  if (allowlist.length > 0) reasons.push('allowlisted');

  if (nameMatched || uuidMatched) return { match: true, reasons };
  return { match: false, reasons };
}

/** Noble peripheral -> hirdetés-leírás. */
export function describePeripheral(peripheral) {
  const advert = peripheral.advertisement || {};
  return {
    address: normalizeAddress(peripheral.id || peripheral.address),
    name: advert.localName || peripheral.name || '',
    rssi: typeof peripheral.rssi === 'number' ? peripheral.rssi : null,
    serviceUuids: advert.serviceUuids || [],
    manufacturerData: advert.manufacturerData
      ? Buffer.from(advert.manufacturerData).toString('hex')
      : null,
  };
}

/**
 * Scanner — a BlueZ-en csak egy discovery futhat egyszerre, ezért a hívások
 * sorba állnak (a `scan` és a `connect` ne ütközjön össze).
 */
export class RobotScanner {
  /**
   * @param {{noble: object, filters: object}} options
   */
  constructor({ noble, filters = {} }) {
    this.noble = noble;
    this.filters = filters;
    this._tail = Promise.resolve();
  }

  /** Sorba állít egy feladatot; a sor soha nem szakad meg. */
  _enqueue(task) {
    const result = this._tail.then(task, task);
    this._tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Robotok keresése a környezetben.
   * @param {{durationMs?: number, onFound?: (robot: object) => void}} options
   * @returns {Promise<object[]>} a talált robotok (cím szerint rendezve)
   */
  scan(options = {}) {
    return this._enqueue(() => this._scanOnce(options));
  }

  async _scanOnce({ durationMs = this.filters.scanMs || 10000, onFound } = {}) {
    const found = new Map();
    const onDiscover = (peripheral) => {
      const advert = describePeripheral(peripheral);
      const verdict = matchRobot(advert, this.filters);
      if (!verdict.match) return;
      const existing = found.get(advert.address);
      const robot = {
        ...advert,
        reasons: verdict.reasons,
        peripheral,
      };
      if (existing) {
        existing.rssi = advert.rssi ?? existing.rssi;
        existing.lastSeen = Date.now();
        existing.peripheral = peripheral;
      } else {
        robot.firstSeen = Date.now();
        robot.lastSeen = robot.firstSeen;
        found.set(advert.address, robot);
      }
      if (onFound) onFound(found.get(advert.address));
    };

    this.noble.on('discover', onDiscover);
    try {
      await this._startDiscovery();
      await sleep(durationMs);
    } finally {
      this.noble.removeListener('discover', onDiscover);
      await this._stopDiscovery();
    }

    return [...found.values()]
      .map(({ peripheral, ...rest }) => rest)
      .sort((a, b) => a.address.localeCompare(b.address));
  }

  /**
   * Egy adott című robottal kapcsolatba lép (a scan közben "felébreszti").
   *
   * A hirdetésre **azonnal** visszatér (nem a scanablak végén), hogy a
   * connect a lehető legkisebb késéssel induljon — a Codie egyetlen hirdetés
   * után visszaalvik, és csak ébredéskor fogad kapcsolatot.
   *
   * @returns {Promise<object|null>} a noble peripheral, vagy null
   */
  findPeripheral(address, options = {}) {
    return this._enqueue(() => this._findPeripheralOnce(address, options));
  }

  async _findPeripheralOnce(address, { durationMs = this.filters.scanMs || 10000 } = {}) {
    const wanted = normalizeAddress(address);
    let peripheral = null;
    let resolveFound = null;
    const found = new Promise((resolve) => {
      resolveFound = resolve;
    });

    const onDiscover = (candidate) => {
      if (normalizeAddress(candidate.id || candidate.address) !== wanted) return;
      peripheral = candidate;
      resolveFound(candidate);
    };

    this.noble.on('discover', onDiscover);
    try {
      await this._startDiscovery();
      const timer = setTimeout(() => resolveFound(null), durationMs);
      try {
        await found;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      this.noble.removeListener('discover', onDiscover);
      await this._stopDiscovery();
    }
    return peripheral;
  }

  /**
   * Kapcsolatépítési session: a discovery **nyitva marad**, és minden hirdetésre
   * meghívja a callbacket.
   *
   * Miért kell: a Codie egyetlen hirdetés után visszaalvik. Ha minden
   * connect-próbához új scan-sessiont nyitnánk, a BlueZ a gyorsítótárazott
   * (régen látott) bejegyzést adná vissza újra és újra — és soha nem érnénk el a
   * valódi ébredést. Egy nyitva tartott sessionben viszont a következő hirdetés
   * már a robot friss ébredése.
   *
   * A callbackok sorban futnak; a session a megadott ideig tart.
   */
  async connectSession(address, { durationMs = 10000, onPeripheral } = {}) {
    return this._enqueue(async () => {
      const wanted = normalizeAddress(address);
      let chain = Promise.resolve();
      const listener = (candidate) => {
        if (normalizeAddress(candidate.id || candidate.address) !== wanted) return;
        chain = chain.then(() => onPeripheral(candidate)).catch(() => {
          /* egy sikertelen próbálkozás ne szakítsa meg a sessiont */
        });
      };
      this.noble.on('discover', listener);
      try {
        await this._startDiscovery();
        await sleep(durationMs);
        await chain;
      } finally {
        this.noble.removeListener('discover', listener);
        await this._stopDiscovery();
      }
    });
  }

  /**
   * Felébresztő scan (a Python kliens `_scan_wake` függvényének megfelelően).
   *
   * Ha a connect "not found"-dal elhasal (a BlueZ még nem ismeri a címet), ez a scan
   * felfedezi a robotot a BlueZ-ben — és közben fel is ébreszti.
   *
   * @returns {Promise<object|null>} a talált peripheral, vagy null
   */
  async wakeScan(address, { durationMs = 6000 } = {}) {
    return this._enqueue(() => this._wakeScanOnce(address, { durationMs }));
  }

  async _wakeScanOnce(address, { durationMs }) {
    const wanted = normalizeAddress(address);
    let peripheral = null;
    let resolveFound = null;
    const found = new Promise((resolve) => {
      resolveFound = resolve;
    });
    const onDiscover = (candidate) => {
      if (normalizeAddress(candidate.id || candidate.address) !== wanted) return;
      peripheral = candidate;
      resolveFound(candidate);
    };
    this.noble.on('discover', onDiscover);
    try {
      await this._startDiscovery();
      const timer = setTimeout(() => resolveFound(null), durationMs);
      try {
        await found;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      this.noble.removeListener('discover', onDiscover);
      await this._stopDiscovery();
    }
    return peripheral;
  }

  /**
   * A discovery elindítása **időtartam-biztosított**.
   *
   * A noble a `startScanning` promise-t a binding 'scanStart' eseményéből oldja fel,
   * a BlueZ binding pedig a hibaüzenetet egy 'warning' eseménybe teszi (nem elutasítja a
   * promise-t) → hiba esetén a promise soha nem teljesülne, és a scanner sora örökre
   * megállna. Ezért: warning-ra azonnal bukunk, és van egy időtartam is.
   */
  async _startDiscovery() {
    let timer = null;
    let onWarning = null;
    const warning = new Promise((_, reject) => {
      onWarning = (message) => reject(new Error(`A BLE discovery nem indult el: ${message}`));
      this.noble.on('warning', onWarning);
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`A BLE discovery indítása timeoutolt (${DISCOVERY_TIMEOUT_MS} ms).`)),
        DISCOVERY_TIMEOUT_MS,
      );
    });
    const start = this.noble.startScanningAsync([], true);
    start.catch(() => {
      /* a warning-ág kezeli; a race után ez már nem érdekes */
    });
    try {
      await Promise.race([start, warning, timeout]);
    } finally {
      clearTimeout(timer);
      if (onWarning) this.noble.removeListener('warning', onWarning);
    }
  }

  /** A discovery leállítása — a hiba itt nem kritikus, de ne akadjon el. */
  async _stopDiscovery() {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`A BLE discovery leállítása timeoutolt (${DISCOVERY_TIMEOUT_MS} ms).`)),
        DISCOVERY_TIMEOUT_MS,
      );
    });
    const stop = this.noble.stopScanningAsync();
    stop.catch(() => {
      /* nem kritikus */
    });
    try {
      await Promise.race([stop, timeout]);
    } catch {
      /* a discovery leállítása nem kritikus */
    } finally {
      clearTimeout(timer);
    }
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
