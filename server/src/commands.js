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

/**
 * Számparaméter validálása.
 *
 * A `Number('abc')` → NaN, ami csendben 0-vá esne össze — egy hibás kérés így
 * például 0 fokos, de balra forgó robotot eredményezne. Ezért a NaN hibát dob.
 */
function numberParam(value, name, { min, max, integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    const error = new Error(
      `A "${name}" paraméternek véges számnak kell lennie (kapott: ${JSON.stringify(value)}).`,
    );
    error.status = 400;
    throw error;
  }
  let result = parsed;
  if (integer) result = Math.trunc(result);
  if (min !== undefined) result = Math.max(min, result);
  if (max !== undefined) result = Math.min(max, result);
  return result;
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
      const ms = numberParam(params.ms ?? 500, 'ms', { min: 1, max: 10000, integer: true });
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
      const index = numberParam(params.index ?? 1, 'index', { min: 1, max: 12, integer: true });
      await client.ledSingle(color, index);
      return { action: 'ledSingle', color, index };
    }
    case 'ledsOff': {
      await client.ledsOff();
      return { action: 'ledsOff' };
    }
    case 'forward': {
      const cm = numberParam(params.cm ?? 10, 'cm', { min: 0, max: MAX_DISTANCE_CM });
      await client.driveDistance(Math.trunc(cm * 10), DRIVE_SPEED, DRIVE_SPEED);
      return { action: 'forward', cm };
    }
    case 'backward': {
      const cm = numberParam(params.cm ?? 10, 'cm', { min: 0, max: MAX_DISTANCE_CM });
      await client.driveDistance(Math.trunc(cm * 10), -DRIVE_SPEED, -DRIVE_SPEED);
      return { action: 'backward', cm };
    }
    case 'turn': {
      const degrees = numberParam(params.degrees ?? 0, 'degrees', { integer: true });
      const magnitude = Math.min(Math.abs(degrees), 360);
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
