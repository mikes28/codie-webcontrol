/**
 * Magas szintű robot-parancsok — a REST API, a CLI scriptek és a konzol
 * ugyanazokat a hívásokat használják, így minden felület azonos viselkedést ad.
 *
 * A mozgásparancsok mind végesek (magától megállnak), a `turn` előjele pedig
 * a Python `mcp_server.py` konvencióját követi: pozitív fok = jobbra.
 */

'use strict';

const DRIVE_SPEED = 40;
const TURN_SPEED = 40;
const MAX_DISTANCE_CM = 200;

export const COMMAND_NAMES = [
  'beep',
  'morse',
  'tune',
  'led',
  'ledSingle',
  'ledsOff',
  'forward',
  'backward',
  'turn',
  'stop',
  'status',
  'battery',
  'sonar',
  'light',
  'line',
  'mic',
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Végrehajt egy magas szintű parancsot a kliensen.
 * @param {object} client CodieClient (vagy a tesztekben egy hamis kliens)
 * @param {string} name parancs neve
 * @param {object} params paraméterek
 * @returns {Promise<object>} eredmény-leírás (a hívó visszaadja a REST/CLI-nak)
 */
export async function runCommand(client, name, params = {}) {
  switch (name) {
    case 'beep': {
      const ms = clamp(Math.trunc(Number(params.ms ?? 500)), 1, 10000);
      await client.beep(ms);
      return { action: 'beep', ms };
    }
    case 'morse': {
      const text = String(params.text ?? '');
      if (!text) throw new Error('A morse parancshoz kell szöveg.');
      await client.playMorse(text, params.unitMs ? Number(params.unitMs) : undefined);
      return { action: 'morse', text };
    }
    case 'tune': {
      const tune = String(params.name ?? '');
      await client.playTune(tune);
      return { action: 'tune', name: tune };
    }
    case 'led': {
      const color = String(params.color ?? 'green');
      await client.ledAll(color);
      return { action: 'led', color };
    }
    case 'ledSingle': {
      const color = String(params.color ?? 'green');
      const index = Math.trunc(Number(params.index ?? 1));
      await client.ledSingle(color, index);
      return { action: 'ledSingle', color, index };
    }
    case 'ledsOff': {
      await client.ledsOff();
      return { action: 'ledsOff' };
    }
    case 'forward': {
      const cm = clamp(Number(params.cm ?? 10), 0, MAX_DISTANCE_CM);
      await client.driveDistance(Math.trunc(cm * 10), DRIVE_SPEED, DRIVE_SPEED);
      return { action: 'forward', cm };
    }
    case 'backward': {
      const cm = clamp(Number(params.cm ?? 10), 0, MAX_DISTANCE_CM);
      await client.driveDistance(Math.trunc(cm * 10), -DRIVE_SPEED, -DRIVE_SPEED);
      return { action: 'backward', cm };
    }
    case 'turn': {
      const degrees = Number(params.degrees ?? 0);
      const magnitude = Math.min(Math.abs(Math.trunc(degrees)), 360);
      // pozitív fok = jobbra -> az API szerint jobbra = NEGATÍV speed
      const speed = degrees >= 0 ? -TURN_SPEED : TURN_SPEED;
      await client.driveTurn(magnitude, speed);
      return { action: 'turn', degrees };
    }
    case 'stop': {
      await client.stop();
      return { action: 'stop' };
    }
    case 'status': {
      return { action: 'status', status: await client.status() };
    }
    case 'battery': {
      return { action: 'battery', pct: await client.battery() };
    }
    case 'sonar': {
      return { action: 'sonar', mm: await client.sonar() };
    }
    case 'light': {
      return { action: 'light', raw: await client.light() };
    }
    case 'line': {
      return { action: 'line', line: await client.line() };
    }
    case 'mic': {
      return { action: 'mic', raw: await client.mic() };
    }
    default:
      throw new Error(`Ismeretlen parancs: ${name}. Elérhető: ${COMMAND_NAMES.join(', ')}`);
  }
}
