/**
 * A scriptek smoke-tesztje.
 *
 * A scriptek a backend moduljait használják — egy hiányzó import (pl. a
 * `registryOptions`) azonnal `ReferenceError`-rel megbuktatja őket, mielőtt
 * bármi BLE-forráshoz nyúlnának. Ez a teszt lefuttatja a scriptek belépési
 * pontját, és ellenőrzi, hogy a hiba nem egy hiányzó import.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.join(here, '..', 'scripts');

/**
 * Lefuttat egy scriptet, és visszaadja a kimenetét.
 *
 * A gyermek-folyamatot **időzítéssel** levágjuk (SIGKILL), különben egy
 * beragadó script (a konzol a stdinre vár, a D-Bus-kötés tartja életben az
 * event loopot) a teljes teszt-futtatást beakasztaná.
 *
 * @param {string} script a script fájlneve (a scripts/ mappában)
 * @param {string[]} args
 * @param {number} timeoutMs
 */
function runScript(script, args = [], timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(scriptsDir, script), ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`a ${script} script ${timeoutMs} ms alatt nem végzett`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    // a stdin-t azonnal zárjuk: a scripteknek nem kell input
    child.stdin.end();
  });
}

test('a control script ismeretlen parancsra szabályos hibát ad', async () => {
  const result = await runScript('control.js', ['fly']);
  const output = result.stdout + result.stderr;
  assert.doesNotMatch(output, /ReferenceError/, 'a scriptek moduljai betöltődnek');
  assert.match(output, /Ismeretlen parancs/);
  assert.equal(result.code, 2);
});

test('a console script elindul és a stdin végén kilép', async () => {
  const result = await runScript('console.js');
  const output = result.stdout + result.stderr;
  assert.doesNotMatch(output, /ReferenceError/, 'a scriptek moduljai betöltődnek');
  assert.match(output, /Codie konzol/);
});

test('a scan script a BLE réteg nélkül is betöltődik (--help)', async () => {
  // a --help nem nyúl a rádióhoz: így a teszt adapterfüggetlen (és a
  // fejlesztő fizikai robotja mellett is futtatható)
  const result = await runScript('scan.js', ['--help']);
  const output = result.stdout + result.stderr;
  assert.doesNotMatch(output, /ReferenceError/, 'a scriptek moduljai betöltődnek');
  assert.match(output, /--duration/);
});
