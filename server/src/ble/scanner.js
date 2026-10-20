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
  if (allowlist.length > 0 && !allowlisted) {
    return { match: false, reasons: ['not-allowlisted'] };
  }
  if (allowlist.length > 0) reasons.push('allowlisted');

  if (filters.macOnly && allowlisted) return { match: true, reasons };
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
      await this.noble.startScanningAsync([], true);
      await sleep(durationMs);
    } finally {
      this.noble.removeListener('discover', onDiscover);
      try {
        await this.noble.stopScanningAsync();
      } catch {
        /* a discovery leállítása nem kritikus */
      }
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
      await this.noble.startScanningAsync([], true);
      const timer = setTimeout(() => resolveFound(null), durationMs);
      try {
        await found;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      this.noble.removeListener('discover', onDiscover);
      try {
        await this.noble.stopScanningAsync();
      } catch {
        /* nem kritikus */
      }
    }
    return peripheral;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
