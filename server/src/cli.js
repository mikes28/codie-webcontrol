/**
 * Kis CLI-segédeszközök — argumentumok értelmezése és táblázatos kiírás.
 * (Nincs külső függőség — a scriptek offline is futnak.)
 */

'use strict';

/**
 * `--flag`, `--key value`, `--key=value` és pozicionális argumentumok.
 * @param {string[]} argv
 * @returns {{_: string[], flags: Record<string, string|boolean>}}
 */
export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[body] = argv[i + 1];
        i += 1;
      } else {
        flags[body] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { _: positional, flags };
}

/** Igaz, ha a flag be van kapcsolva (`--flag`, `--flag=1`, `--flag=true`). */
export function flagEnabled(value) {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return /^(1|true|yes|on)$/i.test(value);
}

/** Robot-lista kiírása táblázatként. */
export function formatRobotTable(robots) {
  if (!robots.length) return 'Nincs találat.';
  const rows = robots.map((robot) => [
    robot.address,
    robot.name || '(névtelen)',
    robot.rssi === null || robot.rssi === undefined ? '-' : `${robot.rssi} dBm`,
    robot.connected ? 'csatlakozva' : 'offline',
    (robot.reasons || []).join(','),
  ]);
  const headers = ['CÍM', 'NÉV', 'RSSI', 'ÁLLAPOT', 'SZŰRŐ'];
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/**
 * A vonal-érték kiírása — a generációtól függően más alakú:
 *  - routing: bal/jobb (12 bites értékek);
 *  - routing nélküli: egyetlen fix-pontos érték (level + „vonalt követ”).
 */
export function formatLine(line) {
  if (!line) return 'vonal: -';
  if (typeof line.level === 'number') {
    return `vonal: ${line.level} (${line.onLine ? 'vonalt követ' : 'vonal nélkül'})`;
  }
  return `vonal bal=${line.left ?? '?'} jobb=${line.right ?? '?'}`;
}

/** Telemetria kiírása olvashatóan. */
export function formatTelemetry(telemetry) {
  if (!telemetry) return 'Nincs telemetria.';
  return [
    `akku: ${telemetry.batteryPct ?? '?'}%`,
    `szonár: ${telemetry.sonarMm ?? '?'} mm`,
    `fény: ${telemetry.lightRaw ?? '?'}`,
    formatLine(telemetry.line),
  ].join(' | ');
}

/**
 * Tiszta kilépés: a stdout írása aszinkron lehet, ezért **nem** hívunk azonnali
 * `process.exit()`-et (az eldobná a ki nem flush-olt kimenetet). A BLE kapcsolatot
 * lezárjuk, és a kilépési kódot exitCode-ként adjuk át.
 */
export function finish(code = 0, noble = null) {
  process.exitCode = code;
  try {
    noble?.stop?.();
  } catch {
    /* a lezárás nem kritikus */
  }
  // biztonsági háló: ha valami még tartja az event loopot, szabaduljunk el
  setTimeout(() => process.exit(code), 500).unref();
}
