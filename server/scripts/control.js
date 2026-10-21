#!/usr/bin/env node
/**
 * Egy parancs futtatása egy roboton (non-interaktív).
 *
 *   node scripts/control.js --robot 00:07:80:66:F0:DB led red
 *   node scripts/control.js --robot <CÍM> forward 20
 *   node scripts/control.js led red            # --robot nélkül: scan, az első találat
 *   node scripts/control.js --robot <CÍM> status --json
 *
 * A parancsok a `src/commands.js` szemantikáját követik — ugyanazt, amit a REST
 * API és a konzol is használ.
 */

import { config, registryOptions } from '../src/config.js';
import { getNoble, ensurePoweredOn } from '../src/ble/noble.js';
import { RobotRegistry } from '../src/ble/registry.js';
import { parseArgs, formatTelemetry, finish } from '../src/cli.js';

const { _: positional, flags } = parseArgs(process.argv.slice(2));

const commandName = positional[0];
if (!commandName) {
  console.error(
    'Használat: node scripts/control.js [--robot <CÍM>] <parancs> [érték]\n' +
      'Parancsok: led|leds|anim|beep|morse|tune|forward|backward|turn|stop|status|battery|sonar|light|line|mic',
  );
  process.exit(2);
}

const args = positional.slice(1);
const registry = new RobotRegistry({
  noble: getNoble({ adapterId: config.ble.adapterId }),
  filters: config.ble,
  ...registryOptions(config.ble),
  telemetryMs: 0,
});

function buildCommand() {
  switch (commandName) {
    case 'led':
      if (args[1]) return { name: 'ledSingle', params: { color: args[0], index: Number(args[1]) } };
      return { name: 'led', params: { color: args[0] ?? 'green' } };
    case 'leds':
      return { name: 'ledsOff', params: {} };
    case 'anim':
      // anim <0|1> [szín] — a beépített LED-animáció
      return {
        name: 'ledAnim',
        params: { animation: Number(args[0] ?? 0), color: args[1] ?? 'red' },
      };
    case 'beep':
      return { name: 'beep', params: { ms: Number(args[0] ?? 500) } };
    case 'morse':
      return { name: 'morse', params: { text: args.join(' ') } };
    case 'tune':
      return { name: 'tune', params: { name: args[0] } };
    case 'forward':
      return { name: 'forward', params: { cm: Number(args[0] ?? 10) } };
    case 'backward':
      return { name: 'backward', params: { cm: Number(args[0] ?? 10) } };
    case 'turn':
      return { name: 'turn', params: { degrees: Number(args[0] ?? 0) } };
    case 'stop':
      return { name: 'stop', params: {} };
    case 'status':
    case 'battery':
    case 'sonar':
    case 'light':
    case 'line':
    case 'mic':
      return { name: commandName, params: {} };
    default:
      return null;
  }
}

const command = buildCommand();
if (!command) {
  console.error(`Ismeretlen parancs: ${commandName}`);
  finish(2, registry.scanner.noble);
} else {
  await run(command);
}

async function run(command) {
  const noble = registry.scanner.noble;
  // A BLE adapter legyen kész a scan/connect előtt.
  await ensurePoweredOn(noble, 10000);

  let address = flags.robot ?? flags.r;
  if (!address) {
    console.log('Nincs --robot megadva, keresem a robotokat...');
    const robots = await registry.scan({ durationMs: config.ble.scanMs });
    if (!robots.length) {
      console.error('Nem találtam robotot. Próbáld újra, ha a robot ébren van.');
      finish(1, noble);
      return;
    }
    address = robots[0].address;
    console.log(`Találtam: ${address} (${robots[0].name})`);
  }

  console.log(`Csatlakozás: ${address} ...`);
  let code = 0;
  try {
    await registry.connect(address);
    console.log('Csatlakozva.');
    const result = await registry.command(address, command.name, command.params);
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.action === 'status') {
      console.log(formatTelemetry(result.status));
    } else {
      console.log(`OK: ${result.action}`);
    }
  } catch (error) {
    console.error(`Hiba: ${error.message}`);
    code = 1;
  } finally {
    await registry.disconnectAll();
  }
  finish(code, noble);
}
