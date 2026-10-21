#!/usr/bin/env node
/**
 * Robot-felderítés — csak a Codie robotok jelennek meg (a többi BLE eszköz nem).
 *
 *   node scripts/scan.js
 *   node scripts/scan.js --duration 20000
 *   node scripts/scan.js --name Codie --mac DF:74:94:43:36:ED
 *   node scripts/scan.js --json
 *
 * A szűrés környezeti változókkal is felülírható:
 *   CODIE_ROBOT_NAME, CODIE_ROBOT_UUIDS, CODIE_MAC_ALLOWLIST, CODIE_MAC_ONLY
 */

import { config } from '../src/config.js';
import { getNoble, ensurePoweredOn } from '../src/ble/noble.js';
import { RobotScanner } from '../src/ble/scanner.js';
import { parseArgs, flagEnabled, formatRobotTable, finish } from '../src/cli.js';

const { _: positional, flags } = parseArgs(process.argv.slice(2));

if (flags.help || flags.h) {
  console.log(
    'Használat: node scripts/scan.js [--duration <ms>] [--name <név>] [--mac <cím>] [--json]\n' +
      'A környezetben lévő Codie robotokat keresi (a többi BLE eszköz kiszűrve).',
  );
  process.exit(0);
}

const filters = {
  ...config.ble,
  nameFilter: flags.name ?? config.ble.nameFilter,
  macAllowlist: flags.mac ? [flags.mac] : config.ble.macAllowlist,
  macOnly: flags['mac-only'] !== undefined ? flagEnabled(flags['mac-only']) : config.ble.macOnly,
};

const durationMs = Number(flags.duration ?? flags.d ?? positional[0] ?? config.ble.scanMs);

const noble = getNoble({ adapterId: config.ble.adapterId });
await ensurePoweredOn(noble, 10000);

const scanner = new RobotScanner({ noble, filters });
console.log(
  `Scannelek ${Math.round(durationMs / 1000)} mp-ig (szűrő: név="${filters.nameFilter}", ` +
    `allowlist=${filters.macAllowlist.join(',') || 'nincs'})...`,
);

const robots = await scanner.scan({ durationMs });

if (flags.json) {
  console.log(JSON.stringify(robots, null, 2));
} else {
  console.log(formatRobotTable(robots));
  if (robots.length) {
    console.log('\nKapcsolódás: node scripts/control.js --robot <CÍM> status');
  }
}

finish(0, noble);
