/**
 * Morse-kód → ritmusminta a Codie fix-frekvenciás csipogójához (JS port).
 *
 * A Codie hangszórója csak egyetlen hangmagasságon szól, de a csipogások
 * hosszát és a szüneteket vezérelhetjük — ez épp elég Morse-kódhoz.
 */

'use strict';

export const MORSE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.',
  F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
  K: '-.-', L: '.-..', M: '--', N: '-.', O: '---',
  P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
  U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--',
  Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-',
  5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.',
  '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-',
  '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-',
  '+': '.-.-.', '-': '-....-', _: '..--.-', '"': '.-..-.',
  '@': '.--.-.',
};

/**
 * Szöveg -> [(csipogás_ms, szünet_ms), ...] Morse-ritmus.
 * Az ismeretlen karaktereket kihagyja; a záró szünet 0.
 * @returns {Array<[number, number]>}
 */
export function textToRhythm(text, unitMs = 120) {
  const words = String(text)
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean);
  const pattern = [];
  for (let wi = 0; wi < words.length; wi += 1) {
    const chars = [...words[wi]].filter((c) => MORSE[c] !== undefined);
    for (let ci = 0; ci < chars.length; ci += 1) {
      const code = MORSE[chars[ci]];
      for (let si = 0; si < code.length; si += 1) {
        const beep = unitMs * (code[si] === '-' ? 3 : 1);
        let gap;
        if (si < code.length - 1) gap = unitMs;        // jelek közt egy betűn belül
        else if (ci < chars.length - 1) gap = unitMs * 3; // betűk közt
        else if (wi < words.length - 1) gap = unitMs * 7; // szavak közt
        else gap = 0;                                  // a legvégén nincs szünet
        pattern.push([beep, gap]);
      }
    }
  }
  return pattern;
}
