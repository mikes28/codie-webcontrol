#!/usr/bin/env node
/**
 * Interaktív robot-konzol — a backend moduljait használja (ugyanaz a
 * `RobotRegistry` + `runCommand`, mint a REST API).
 *
 *   node scripts/console.js
 *
 * Parancsok: help, scan, robots, connect <cím>, disconnect, use <cím>,
 * status, battery, sonar, light, line, mic, led <szín> [index], leds off,
 * anim <0|1> [szín], beep [ms], morse <szöveg>, tune <név>, forward [cm],
 * backward [cm], turn [fok], stop, quit.
 */

import readline from 'node:readline';

import { config, registryOptions } from '../src/config.js';
import { getNoble, ensurePoweredOn } from '../src/ble/noble.js';
import { RobotRegistry } from '../src/ble/registry.js';
import { formatRobotTable, formatTelemetry, finish } from '../src/cli.js';

const registry = new RobotRegistry({
  noble: getNoble({ adapterId: config.ble.adapterId }),
  filters: config.ble,
  ...registryOptions(config.ble),
  telemetryMs: 0,
});

let activeAddress = null;

const HELP = `
Parancsok:
  scan [ms]              robotok keresése a környezetben (csak Codie-k)
  robots                 ismert robotok listája
  connect <cím>          csatlakozás (a scan után a cím látható)
  disconnect [cím]       lekapcsolás (alapértelmezett: az aktív robot)
  use <cím>              aktív robot kiválasztása
  status                 akku, szonár, fény, vonal
  battery | sonar | light | line | mic
  led <szín> [index]     LED-ek (white|green|red|blue|cyan|yellow|orange)
  leds off               LED-ek kikapcsolva
  anim <0|1> [szín]      beépített LED-animáció (routing nélküli generáció)
  beep [ms]              sípolás
  morse <szöveg>         Morse-kód
  tune <név>             beépített ritmus
  forward [cm]           előre (max 200 cm)
  backward [cm]          hátra (max 200 cm)
  turn <fok>             fordul (pozitív = jobbra)
  stop                   azonnali megállás
  help | quit
`;

function printActive() {
  if (!activeAddress) return 'Nincs aktív robot (connect <cím>).';
  const robot = registry.get(activeAddress);
  if (!robot) return 'Nincs aktív robot.';
  const telemetry = robot.telemetry ? formatTelemetry(robot.telemetry) : 'nincs telemetria';
  return `${robot.address} (${robot.name || 'névtelen'}) — ${robot.connected ? 'csatlakozva' : 'offline'} | ${telemetry}`;
}

async function handle(line) {
  const [command, ...args] = line.trim().split(/\s+/);
  switch (command) {
    case '':
      return;
    case 'help':
    case '?':
      console.log(HELP);
      return;
    case 'scan': {
      const durationMs = Number(args[0] ?? config.ble.scanMs);
      console.log(`Scannelek ${Math.round(durationMs / 1000)} mp-ig...`);
      const robots = await registry.scan({ durationMs });
      console.log(formatRobotTable(robots));
      return;
    }
    case 'robots':
      console.log(formatRobotTable(registry.list()));
      return;
    case 'connect': {
      const address = args[0];
      if (!address) throw new Error('connect <cím>');
      console.log(`Csatlakozás: ${address} ...`);
      const robot = await registry.connect(address);
      activeAddress = robot.address;
      console.log(`Csatlakozva: ${robot.address}`);
      return;
    }
    case 'disconnect': {
      const address = args[0] ?? activeAddress;
      if (!address) throw new Error('disconnect [cím]');
      await registry.disconnect(address);
      if (activeAddress === address) activeAddress = null;
      console.log('Lekapcsolva.');
      return;
    }
    case 'use': {
      const address = args[0];
      if (!address) throw new Error('use <cím>');
      const robot = registry.get(address);
      if (!robot) throw new Error(`Ismeretlen robot: ${address}`);
      activeAddress = robot.address;
      console.log(`Aktív robot: ${robot.address}`);
      return;
    }
    case 'status': {
      const result = await registry.command(activeAddress, 'status', {});
      console.log(formatTelemetry(result.status));
      return;
    }
    case 'battery':
    case 'sonar':
    case 'light':
    case 'line':
    case 'mic': {
      const result = await registry.command(activeAddress, command, {});
      console.log(JSON.stringify(result));
      return;
    }
    case 'led': {
      const color = args[0];
      if (!color) throw new Error('led <szín> [index]');
      if (args[1]) {
        await registry.command(activeAddress, 'ledSingle', { color, index: Number(args[1]) });
      } else {
        await registry.command(activeAddress, 'led', { color });
      }
      console.log(`LED: ${color}`);
      return;
    }
    case 'leds': {
      await registry.command(activeAddress, 'ledsOff', {});
      console.log('LED-ek kikapcsolva.');
      return;
    }
    case 'anim': {
      const animation = Number(args[0] ?? 0);
      const color = args[1] ?? 'red';
      await registry.command(activeAddress, 'ledAnim', { animation, color });
      console.log(`Animáció ${animation} (${color}).`);
      return;
    }
    case 'beep': {
      await registry.command(activeAddress, 'beep', { ms: Number(args[0] ?? 500) });
      console.log('Beep.');
      return;
    }
    case 'morse': {
      const text = args.join(' ');
      if (!text) throw new Error('morse <szöveg>');
      await registry.command(activeAddress, 'morse', { text });
      console.log(`Morse: ${text}`);
      return;
    }
    case 'tune': {
      const name = args[0];
      if (!name) throw new Error('tune <név>');
      await registry.command(activeAddress, 'tune', { name });
      console.log(`Ritmus: ${name}`);
      return;
    }
    case 'forward':
    case 'backward': {
      const cm = Number(args[0] ?? 10);
      await registry.command(activeAddress, command, { cm });
      console.log(`${command} ${cm} cm`);
      return;
    }
    case 'turn': {
      const degrees = Number(args[0] ?? 0);
      await registry.command(activeAddress, 'turn', { degrees });
      console.log(`turn ${degrees}°`);
      return;
    }
    case 'stop':
      await registry.command(activeAddress, 'stop', {});
      console.log('Megállt.');
      return;
    case 'quit':
    case 'exit':
      closing = true;
      rl.close();
      return;
    default:
      console.log(`Ismeretlen parancs: ${command} (help)`);
  }
}

// A BLE adapter legyen kész, mielőtt bármi parancs futhat — különben az első
// scan "state is unknown" hibával szaladna el.
try {
  await ensurePoweredOn(registry.scanner.noble, 10000);
} catch (error) {
  console.warn(`BLE adapter nem elérhető: ${error.message}`);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let queue = Promise.resolve();
let pending = Promise.resolve();
let closing = false;
rl.prompt();

console.log('Codie konzol — "help" a parancsokhoz, "quit" a kilépéshez.');
console.log(
  `Szűrő: név="${config.ble.nameFilter}", allowlist=${config.ble.macAllowlist.join(',') || 'nincs'}`,
);

rl.on('line', (line) => {
  // A parancsok sorba állnak: egy BLE-művelet (pl. scan) befejeződjön, mielőtt
  // a következő elindul — így a betöltött (pipe-olt) input is helyesen sorrendben fut.
  pending = queue = queue
    .then(() => handle(line))
    .catch((error) => {
      console.error(`Hiba: ${error.message}`);
    })
    .finally(() => {
      if (activeAddress) {
        const robot = registry.get(activeAddress);
        if (robot?.connected) console.log(`[${robot.address}] online`);
      }
      if (!closing) rl.prompt();
    });
});

rl.on('close', async () => {
  // stdin EOF vagy "quit": a futó parancs még fejeződjön be, ne szakítsuk meg.
  await pending.catch(() => {});
  console.log('\nLecsatlakozás...');
  await registry.disconnectAll();
  finish(0, registry.scanner.noble);
});
