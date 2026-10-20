/** A robot-szűrő tesztje: más BLE eszközök nem juthatnak át. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { matchRobot, describePeripheral, RobotScanner } from '../src/ble/scanner.js';
import { normalizeAddress } from '../src/ble/noble.js';
import { SERVICE_UUID } from '../src/ble/protocol.js';

const FILTERS = {
  nameFilter: 'Codie',
  serviceUuids: [SERVICE_UUID, 'd46e7e53ba2f4044ade9f85ead45f458'],
  macAllowlist: [],
  macOnly: false,
};

test('a robot neve alapján átmegy', () => {
  const verdict = matchRobot(
    { address: '00:07:80:66:F0:DB', name: 'Codie', serviceUuids: ['1800', '180a'] },
    FILTERS,
  );
  assert.equal(verdict.match, true);
  assert.ok(verdict.reasons.includes('name'));
});

test('a név kis/nagybetű független', () => {
  assert.equal(matchRobot({ address: 'AA:BB:CC:DD:EE:FF', name: 'codie' }, FILTERS).match, true);
});

test('a második robot ("Codie 2") is átmegy', () => {
  assert.equal(matchRobot({ address: 'AA:BB:CC:DD:EE:01', name: 'Codie 2' }, FILTERS).match, true);
});

test('a hirdetett UUID alapján a nameless robot is átmegy', () => {
  const verdict = matchRobot(
    { address: 'AA:BB:CC:DD:EE:02', name: '', serviceUuids: [SERVICE_UUID] },
    FILTERS,
  );
  assert.equal(verdict.match, true);
  assert.ok(verdict.reasons.includes('service-uuid'));
});

test('a hirdetett UUID kötőjel nélküli alakban is átmegy (ahogy a BlueZ adja)', () => {
  const verdict = matchRobot(
    { address: 'AA:BB:CC:DD:EE:03', name: '', serviceUuids: ['52af0001978a628dc8450a104ca2b8dd'] },
    FILTERS,
  );
  assert.equal(verdict.match, true);
  assert.ok(verdict.reasons.includes('service-uuid'));
});

test('a fehallgató, a telefon és a fitnesz karika nem megy át', () => {
  const others = [
    { address: '00:1e:7c:ca:ec:16', name: 'HAYLOU S35 ANC', serviceUuids: ['110b', '111e'] },
    { address: '00:13:d6:99:08:a1', name: 'Redmi Buds 6 Play', serviceUuids: ['110b', '1200'] },
    { address: '3c:13:5a:16:37:ea', name: 'Redmi Note 12 Pro', serviceUuids: ['180f'] },
    { address: '4f:ba:90:82:f6:c3', name: '', serviceUuids: ['0000fcf1'] },
    { address: '00:00:00:00:3c:83', name: 'Xiaomi Sound Outdoor', serviceUuids: ['111e'] },
  ];
  for (const other of others) {
    assert.equal(matchRobot(other, FILTERS).match, false, `${other.name || other.address} nem lehet robot`);
  }
});

test('az allowlist kizárja a többi robotot', () => {
  const filters = { ...FILTERS, macAllowlist: ['00:07:80:66:F0:DB'] };
  assert.equal(
    matchRobot({ address: '00:07:80:66:F0:DB', name: 'Codie' }, filters).match,
    true,
  );
  const rejected = matchRobot({ address: '00:07:80:66:F0:DC', name: 'Codie' }, filters);
  assert.equal(rejected.match, false);
  assert.deepEqual(rejected.reasons, ['not-allowlisted']);
});

test('a MAC-only módban az allowlist elég a név nélkül is', () => {
  const filters = { ...FILTERS, macAllowlist: ['00:07:80:66:F0:DB'], macOnly: true };
  assert.equal(matchRobot({ address: '00078066F0DB', name: '' }, filters).match, true);
});

test('a MAC-only módban üres allowlist mellett semmi nem megy át', () => {
  const filters = { ...FILTERS, macAllowlist: [], macOnly: true };
  const verdict = matchRobot({ address: '00:07:80:66:F0:DB', name: 'Codie' }, filters);
  assert.equal(verdict.match, false, 'üres allowlist mellett nincs engedélyezett cím');
});

test('a MAC-only módban a néven átmenő, de nem allowlistelt robot sem megy át', () => {
  const filters = { ...FILTERS, macAllowlist: ['00:07:80:66:F0:DB'], macOnly: true };
  const verdict = matchRobot({ address: '00:07:80:66:F0:DC', name: 'Codie' }, filters);
  assert.equal(verdict.match, false);
});

test('a scanner nem akad meg, ha a BLE binding hibát jelez induláskor', async () => {
  // A noble a startScanning promise-t a binding 'scanStart' eseményéből oldja fel,
  // a BlueZ binding pedig a hibát 'warning' eseménybe teszi → a promise soha nem
  // teljesülne. A scannernek viszont hibával kell kilépnie, nem akadnia meg.
  class WarningNoble extends EventEmitter {
    constructor() {
      super();
      this.state = 'poweredOn';
    }

    async startScanningAsync() {
      setTimeout(() => this.emit('warning', 'startScanning failed: adapter not initialized'), 5);
      return new Promise(() => {});
    }

    async stopScanningAsync() {
      return new Promise(() => {});
    }
  }

  const scanner = new RobotScanner({ noble: new WarningNoble(), filters: FILTERS });
  await assert.rejects(
    () => scanner.scan({ durationMs: 500 }),
    /discovery nem indult el/,
  );
});

test('a cím formázása egységes', () => {
  assert.equal(normalizeAddress('00078066f0db'), '00:07:80:66:F0:DB');
  assert.equal(normalizeAddress('00:07:80:66:F0:DB'), '00:07:80:66:F0:DB');
  assert.equal(normalizeAddress('df74944336ed'), 'DF:74:94:43:36:ED');
});

test('a noble peripheral-leírás helyes alakú', () => {
  const described = describePeripheral({
    id: '00078066f0db',
    advertisement: { localName: 'Codie', serviceUuids: ['1800'], manufacturerData: Buffer.from([1, 2]) },
    rssi: -55,
  });
  assert.equal(described.address, '00:07:80:66:F0:DB');
  assert.equal(described.name, 'Codie');
  assert.equal(described.rssi, -55);
  assert.equal(described.manufacturerData, '0102');
});
