/**
 * Noble (BlueZ D-Bus binding) példány — a teljes backend egyetlen BLE
 * "radio"-ja, hogy több robot is kezelhető legyen egyszerre.
 *
 * A D-Bus binding a rendszer BlueZ szolgáltatásával beszél, tehát együtt
 * működik a `bluetoothctl`-lel, és nem igényel root jogosultságot.
 */

'use strict';

import { withBindings } from '@stoprocent/noble';

let instance = null;

/** @returns {import('@stoprocent/noble').Noble} */
export function getNoble({ adapterId = 'hci0' } = {}) {
  if (!instance) {
    instance = withBindings('dbus', { adapterId });
  }
  return instance;
}

/** Megvárja, hogy az adapter be legyen kapcsolva. */
export async function ensurePoweredOn(noble, timeoutMs = 10000) {
  if (noble.state === 'poweredOn') return;
  await noble.waitForPoweredOnAsync(timeoutMs);
}

/**
 * BLE-címet egységes formába hozza: "00:07:80:66:F0:DB".
 * A BLE random (privát) címek lehető 6 bájtos, "00:07:80" prefixűek is.
 */
export function normalizeAddress(address) {
  if (!address) return '';
  const hex = String(address).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) return String(address).toUpperCase();
  return hex.match(/.{2}/g).join(':');
}
