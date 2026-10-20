/**
 * Backend konfiguráció — kizárólag környezeti változókból.
 *
 * A `.env.example` a repó gyökerében található; a szerver indításkor betölti.
 */

'use strict';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadEnvFile } from 'dotenv';

import { SERVICE_UUID } from './ble/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// A repo gyökerének .env-je (a Python oldaléval közös) és a server/.env —
// egyik sem kötelező, a környezeti változók felülírják őket.
loadEnvFile({
  path: [path.join(here, '..', '..', '.env'), path.join(here, '..', '.env')],
  quiet: true,
});

/** A robot által hirdetett vendor-UUID (élőben megfigyelve a 2026-10-20-i scanen). */
export const ADVERTISED_ROBOT_UUID = 'd46e7e53ba2f4044ade9f85ead45f458';

function num(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function list(env, name, fallback = []) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const nameFilter = env.CODIE_ROBOT_NAME || 'Codie';
  const serviceUuids = list(env, 'CODIE_ROBOT_UUIDS', [SERVICE_UUID, ADVERTISED_ROBOT_UUID]);
  const macAllowlist = list(env, 'CODIE_MAC_ALLOWLIST');
  const macOnly = bool(env, 'CODIE_MAC_ONLY', false);

  // MAC-only módban az allowlist az egyetlen szűrő — üres allowlist mellett ez
  // néma hiba lenne (minden "Codie" átmenne), ezért az indulást elbuktatjuk.
  if (macOnly && macAllowlist.length === 0) {
    throw new Error(
      'A CODIE_MAC_ONLY=1 beállításhoz kötelező a CODIE_MAC_ALLOWLIST is (üres allowlist mellett nincs mit engedélyezni).',
    );
  }

  return {
    port: num(env, 'PORT', 3000),
    host: env.HOST || '0.0.0.0',

    ble: {
      adapterId: env.CODIE_ADAPTER || 'hci0',
      /** Identity-szűrő: a robot neve (a Codie hirdeti: "Codie"). */
      nameFilter,
      /** Identity-szűrő: hirdetett service UUID-k, amiket a Codie visz. */
      serviceUuids,
      /** Opcionális MAC-allowlist: csak ezek a címek fogadhatók el. */
      macAllowlist,
      /** true => az allowlist önmagában is elég (név/UUID nélkül is elfogad). */
      macOnly,
      /** Alapértelmezett scan-idő (ms) — a robot ritkán hirdet, ezért ne legyen rövid. */
      scanMs: num(env, 'CODIE_SCAN_MS', 10000),
      connectTimeoutMs: num(env, 'CODIE_CONNECT_TIMEOUT_MS', 20000),
      /** Egy kapcsolódási kísérlet előtti scanablak (ms) — ennyi ideig várunk a robotra. */
      scanWindowMs: num(env, 'CODIE_SCAN_WINDOW_MS', 8000),
      connectRetries: num(env, 'CODIE_CONNECT_RETRIES', 3),
      retryDelayMs: num(env, 'CODIE_RETRY_DELAY_MS', 3000),
      /** Telemetria (szenzorok lekérése) periódusa ms-ben, 0 = kikapcsolva. */
      telemetryMs: num(env, 'CODIE_TELEMETRY_MS', 5000),
    },

    /** A szerver indulásakor automatikusan csatlakozandó robotok címei. */
    autoConnect: list(env, 'CODIE_AUTO_CONNECT'),
  };
}

export const config = loadConfig();
