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
      /**
       * Telemetria (szenzorok lekérése) periódusa ms-ben, 0 = kikapcsolva.
       * A felület érzékelőnként frissül (a mérés megérkezésekor), ezért a
       * periódus a teljes állapotlekérés gyakoriságát adja meg.
       */
      telemetryMs: num(env, 'CODIE_TELEMETRY_MS', 250),
      /** Általános válasz-timeout (ms) egy parancs nyugtázásához. */
      responseTimeoutMs: num(env, 'CODIE_RESPONSE_TIMEOUT_MS', 2500),
      /** Érzékelő-kérés timeoutja (ms) — a robot ~100 ms alatt válaszol. */
      queryTimeoutMs: num(env, 'CODIE_QUERY_TIMEOUT_MS', 1200),
      /** GATT-write timeoutja (ms) — enélkül elalvó robotnál lefagy a szerver. */
      writeTimeoutMs: num(env, 'CODIE_WRITE_TIMEOUT_MS', 3000),
      /** A teljes állapotlekérés (4 érzékelő) legfeljebb ennyi ideig tarthat. */
      statusTimeoutMs: num(env, 'CODIE_STATUS_TIMEOUT_MS', 10000),
      /**
       * Kötelező szünet két BLE-üzenet között (ms).
       * A routing nélküli firmware a túl gyorsan következő üzenetet eldobja —
       * élőben mérve 30 ms is hibátlan volt (a válasz ~100 ms alatt jön), a
       * nyugtázatlan (ritmus) üzeneteknél külön 150 ms érvényes.
       */
      writeGapMs: num(env, 'CODIE_WRITE_GAP_MS', 50),
      /**
       * A mikrofon figyelésének periódusa (ms).
       * A robot egy lekérdezésre ~100 ms alatt válaszol, és a rádió nem bírja
       * a gyors egymás utáni kéréseket — 200 ms alatt a telemetria is kimarad.
       */
      micMs: num(env, 'CODIE_MIC_MS', 200),
      /** Újracsatlakozás egy váratlanul megszakadt kapcsolat után. */
      autoReconnect: bool(env, 'CODIE_AUTO_RECONNECT', true),
      /** Hány alkalommal próbálja újra a kapcsolatot megszakadás után. */
      reconnectAttempts: num(env, 'CODIE_RECONNECT_ATTEMPTS', 3),
      /** Késleltetés az újracsatlakozási próbálkozások között (ms). */
      reconnectDelayMs: num(env, 'CODIE_RECONNECT_DELAY_MS', 5000),
    },

    /** A szerver indulásakor automatikusan csatlakozandó robotok címei. */
    autoConnect: list(env, 'CODIE_AUTO_CONNECT'),
  };
}

/**
 * A `RobotRegistry` opciói a BLE-konfigurációból — egy hely, hogy a szerver
 * és a scriptek ugyanazt használják.
 */
export function registryOptions(ble) {
  return {
    connectTimeout: ble.connectTimeoutMs,
    scanWindow: ble.scanWindowMs,
    connectRetries: ble.connectRetries,
    retryDelay: ble.retryDelayMs,
    responseTimeout: ble.responseTimeoutMs,
    queryTimeout: ble.queryTimeoutMs,
    writeTimeout: ble.writeTimeoutMs,
    statusTimeout: ble.statusTimeoutMs,
    writeGap: ble.writeGapMs,
    telemetryMs: ble.telemetryMs,
    micMs: ble.micMs,
    autoReconnect: ble.autoReconnect,
    reconnectAttempts: ble.reconnectAttempts,
    reconnectDelayMs: ble.reconnectDelayMs,
  };
}

export const config = loadConfig();
