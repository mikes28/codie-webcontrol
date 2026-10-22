/**
 * Robot-scriptek futtatása — a weboldal Python kommunikációs scriptjének
 * elindítása és eseményeinek továbbítása.
 *
 * A BLE réteg a Node.js backendben van, ezért a scriptek is a backend
 * REST API-ján keresztül szólnak a robothoz: a Python oldal (`python/
 * codie_comm.py`) csak a lépéseket hajtja végre és JSON-soros eseményeket
 * ír a stdout-ra. Ezek itt olvashatók és mehetnek tovább a böngészőnek.
 *
 * Egy roboton egyszer futhat script: az újabb indítás 409-et ad.
 */

'use strict';

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** A Python réteg helye a repóban (a `codie_comm.py` és a `scripts/`). */
export const pythonDir = path.join(here, '..', 'python');
/** A Python kommunikációs script belépési pontja. */
export const enginePath = path.join(pythonDir, 'codie_comm.py');
/** A robot-scriptek alapértelmezett helye. */
export const defaultScriptDir = path.join(pythonDir, 'scripts');

/**
 * A scriptek listája egy futó példányból kérhető le (`--list`), így a
 * Node-oldalnak nem kell Python-fájlt parse-olnia.
 *
 * @param {object} options
 * @param {string} options.python a Python értelmező (alap: `python3`)
 * @param {string} options.scriptDir a scriptek mappája
 * @param {number} options.timeoutMs egy futás időhatára
 * @returns {Promise<Array<{name: string, title: string, description: string}>>}
 */
export async function listScripts({ python = 'python3', scriptDir = defaultScriptDir } = {}) {
  const result = await runProcess(python, [enginePath, '--list', '--script-dir', scriptDir]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'A scriptek listázása nem sikerült.');
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    throw new Error(`A scriptek listája nem értelmezhető JSON: ${error.message}`);
  }
}

/**
 * A firmware interfész-regisztere (a visszafejtett robot valódi parancsfelülete).
 *
 * @param {object} options
 * @param {string} options.python a Python értelmező (alap: `python3`)
 * @returns {Promise<object>} a 16 interfész az opjaival
 */
export async function firmwareSurface({ python = 'python3' } = {}) {
  const result = await runProcess(python, [enginePath, '--firmware']);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'A firmware-regiszter lekérése nem sikerült.');
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`A firmware-regiszter nem értelmezhető JSON: ${error.message}`);
  }
}

/** Egy egyszerű folyamat lefuttatása és a kimenet összegyűjtése. */
function runProcess(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * A scriptek futtatója — egy roboton egyszer fut egy script.
 *
 * Események:
 * - `event` — a Python által küldött esemény (`{address, event, …}`),
 * - `exit`  — a futás vége (`{address, code}`).
 */
export class ScriptRunner extends EventEmitter {
  constructor({
    python = process.env.CODIE_PYTHON || 'python3',
    scriptDir = defaultScriptDir,
    timeoutMs = 120000,
    apiUrl = null,
  } = {}) {
    super();
    this.python = python;
    this.scriptDir = scriptDir;
    this.timeoutMs = timeoutMs;
    this.apiUrl = apiUrl;
    /** address -> { child, script, startedAt } */
    this.runs = new Map();
    /** a firmware-regiszter gyorsítótára (a firmware nem változik) */
    this._firmware = null;
  }

  /** A backend saját URL-je (a scriptek ezen keresztül szólnak a robothoz). */
  setApiUrl(url) {
    this.apiUrl = url;
  }

  /** Az elérhető scriptek listája. */
  list() {
    return listScripts({ python: this.python, scriptDir: this.scriptDir });
  }

  /** A firmware interfész-regisztere (a visszafejtett robot parancsfelülete). */
  firmware() {
    if (!this._firmware) {
      this._firmware = firmwareSurface({ python: this.python });
    }
    return this._firmware;
  }

  /** Az adott roboton futó script állapota (``null``, ha nincs). */
  status(address) {
    const run = this.runs.get(address);
    if (!run) return null;
    return { address, script: run.script, startedAt: run.startedAt };
  }

  /**
   * Elindít egy scriptet egy roboton.
   *
   * @param {string} address a robot BLE-címe
   * @param {string} script a script neve (a `scripts/` mappában)
   * @throws {Error} `status = 409`, ha már fut egy script ezen a roboton
   */
  start(address, script) {
    if (this.runs.has(address)) {
      const error = new Error(`A(z) ${address} roboton már fut egy script.`);
      error.status = 409;
      throw error;
    }
    if (!this.apiUrl) {
      const error = new Error('A backend URL-je nincs beállítva — a scriptek nem indíthatók.');
      error.status = 503;
      throw error;
    }

    const child = spawn(
      this.python,
      [
        enginePath,
        '--address',
        address,
        '--api',
        this.apiUrl,
        '--script',
        script,
        '--script-dir',
        this.scriptDir,
        '--timeout',
        String(this.timeoutMs / 1000),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } },
    );

    this.runs.set(address, { child, script, startedAt: Date.now() });

    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.#handleLine(address, line);
        index = buffer.indexOf('\n');
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) this.emit('event', { address, event: 'error', message: text });
    });

    child.on('error', (error) => {
      this.emit('event', { address, event: 'error', message: error.message });
    });

    child.on('close', (code) => {
      this.runs.delete(address);
      this.emit('event', { address, event: 'exit', code });
      this.emit('exit', { address, code });
    });

    return { address, script };
  }

  /** Leállítja a futó scriptet (SIGTERM — a Python oldal megállítja a robothot). */
  stop(address) {
    const run = this.runs.get(address);
    if (!run) return false;
    run.child.kill('SIGTERM');
    return true;
  }

  /** Minden futó script leállítása (a szerver leállásakor). */
  stopAll() {
    for (const address of [...this.runs.keys()]) this.stop(address);
  }

  /** Egy stdout sor értelmezése (a Python JSON eseményeket ír). */
  #handleLine(address, line) {
    try {
      const payload = JSON.parse(line);
      this.emit('event', { address, ...payload });
    } catch {
      this.emit('event', { address, event: 'log', message: line });
    }
  }
}
