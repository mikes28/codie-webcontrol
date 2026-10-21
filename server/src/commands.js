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
  'ledAnim',
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
 * A parancs nyugtázása.
 *
 * A BLE réteg `null`-t ad, ha a robot nem válaszol a megadott időn belül.
 * A felületen ez nem "OK", hanem **hiba**: a felhasználónak látnia kell, hogy
 * a robot nem hajtotta végre a parancsot (a firmware el is dobhatja az üzenetet).
 *
 * @param {unknown} result a kliens visszatérése
 * @param {string} action a parancs neve (a hibaüzenetben)
 */
function requireAck(result, action) {
  if (result === null || result === undefined) {
    const error = new Error(
      `A robot nem nyugtázta a "${action}" parancsot — nem jött válasz a megadott időn belül.`,
    );
    error.status = 504; // Gateway Timeout: a robot nem válaszolt
    throw error;
  }
  return result;
}

/**
 * Az érzékelő válasza — a `null` itt azt jelenti, hogy a robot nem válaszolt.
 * @param {unknown} value a kliens visszatérése
 * @param {string} sensor az érzékelő neve (a hibaüzenetben)
 */
function requireReading(value, sensor) {
  if (value === null || value === undefined) {
    const error = new Error(`A robot nem válaszolt a(z) ${sensor} érzékelő kérésre.`);
    error.status = 504;
    throw error;
  }
  return value;
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
      requireAck(await client.beep(ms), 'beep');
      return { action: 'beep', ms };
    }
    case 'morse': {
      const text = String(params.text ?? '');
      if (!text) throw new Error('A morse parancshoz kell szöveg.');
      // fire-and-forget: a ritmus nyugtázás nélkül szól (a pontos időzítés miatt)
      const unitMs = numberParam(params.unitMs ?? 120, 'unitMs', {
        min: 10,
        max: 1000,
        integer: true,
      });
      await client.playMorse(text, unitMs);
      return { action: 'morse', text, unitMs };
    }
    case 'tune': {
      const tune = String(params.name ?? '');
      await client.playTune(tune);
      return { action: 'tune', name: tune };
    }
    case 'led': {
      const color = String(params.color ?? 'green');
      requireAck(await client.ledAll(color), 'led');
      return { action: 'led', color };
    }
    case 'ledSingle': {
      const color = String(params.color ?? 'green');
      const index = numberParam(params.index ?? 1, 'index', { min: 1, max: 12, integer: true });
      requireAck(await client.ledSingle(color, index), 'ledSingle');
      return { action: 'ledSingle', color, index };
    }
    case 'ledsOff': {
      requireAck(await client.ledsOff(), 'ledsOff');
      return { action: 'ledsOff' };
    }
    case 'ledAnim': {
      // a codiejs referencia szerint két beépített animáció van (0 és 1)
      const animation = numberParam(params.animation ?? 0, 'animation', {
        min: 0,
        max: 1,
        integer: true,
      });
      const color = String(params.color ?? 'red');
      const repeat = numberParam(params.repeat ?? 0, 'repeat', { min: 0, max: 255, integer: true });
      const speed = numberParam(params.speed ?? 10, 'speed', { min: 0, max: 255, integer: true });
      requireAck(await client.ledAnimation(animation, { color, repeat, speed }), 'ledAnim');
      return { action: 'ledAnim', animation, color, repeat, speed };
    }
    case 'forward': {
      const cm = numberParam(params.cm ?? 10, 'cm', { min: 0, max: MAX_DISTANCE_CM });
      requireAck(await client.driveDistance(Math.trunc(cm * 10), DRIVE_SPEED, DRIVE_SPEED), 'forward');
      return { action: 'forward', cm };
    }
    case 'backward': {
      const cm = numberParam(params.cm ?? 10, 'cm', { min: 0, max: MAX_DISTANCE_CM });
      requireAck(await client.driveDistance(Math.trunc(cm * 10), -DRIVE_SPEED, -DRIVE_SPEED), 'backward');
      return { action: 'backward', cm };
    }
    case 'turn': {
      const degrees = numberParam(params.degrees ?? 0, 'degrees', { integer: true });
      const magnitude = Math.min(Math.abs(degrees), 360);
      // pozitív fok = jobbra -> az API szerint jobbra = NEGATÍV speed
      const speed = degrees >= 0 ? -TURN_SPEED : TURN_SPEED;
      requireAck(await client.driveTurn(magnitude, speed), 'turn');
      return { action: 'turn', degrees };
    }
    case 'stop': {
      requireAck(await client.stop(), 'stop');
      return { action: 'stop' };
    }
    case 'status': {
      const status = await client.status();
      // egy hibás érzékelő ne rontsa el a teljes lekérést, de ha egyik sem
      // válaszolt, akkor az nem mérés, hanem hibás kapcsolat
      const readings = [status.batteryPct, status.sonarMm, status.lightRaw, status.line];
      if (readings.every((value) => value === null || value === undefined)) {
        const error = new Error('A robot nem válaszolt egyetlen érzékelő kérésre sem.');
        error.status = 504;
        throw error;
      }
      return { action: 'status', status };
    }
    case 'battery': {
      return { action: 'battery', pct: requireReading(await client.battery(), 'akku') };
    }
    case 'sonar': {
      return { action: 'sonar', mm: requireReading(await client.sonar(), 'szonár') };
    }
    case 'light': {
      return { action: 'light', raw: requireReading(await client.light(), 'fény') };
    }
    case 'line': {
      return { action: 'line', line: requireReading(await client.line(), 'vonal') };
    }
    case 'mic': {
      return { action: 'mic', raw: requireReading(await client.mic(), 'mikrofon') };
    }
    default:
      throw new Error(`Ismeretlen parancs: ${name}. Elérhető: ${COMMAND_NAMES.join(', ')}`);
  }
}
