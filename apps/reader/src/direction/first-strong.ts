import type { Direction } from '../content/schema.js';

const LRM = 0x200e;
const RLM = 0x200f;
const ALM = 0x061c;
const LRI = 0x2066;
const RLI = 0x2067;
const FSI = 0x2068;
const PDI = 0x2069;

const LETTER = /\p{L}/u;

/**
 * Code point ranges whose letters are strong right-to-left (bidi class R or
 * AL): Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic and their
 * supplements and extensions (U+0590-U+08FF), Hebrew and Arabic presentation
 * forms, and the SMP right-to-left blocks (Phoenician to Elymaic, Adlam,
 * Mende Kikakui, Arabic mathematical symbols). An approximation of the
 * Unicode bidi classes by range, documented in the README.
 */
const RTL_RANGES: readonly (readonly [number, number])[] = [
  [0x0590, 0x08ff],
  [0xfb1d, 0xfdff],
  [0xfe70, 0xfeff],
  [0x10800, 0x10fff],
  [0x1e800, 0x1efff],
];

function isRtlCodePoint(cp: number): boolean {
  for (const [from, to] of RTL_RANGES) {
    if (cp >= from && cp <= to) return true;
  }
  return false;
}

/**
 * The direction of the first strong character (Unicode bidi rule P2,
 * architecture P3, AC11): letters in right-to-left scripts and RLM/ALM give
 * `rtl`; any other letter and LRM give `ltr`; text between an isolate
 * initiator (LRI, RLI, FSI) and its matching PDI is skipped. Returns `null`
 * for empty or direction-neutral text (digits, punctuation, spaces).
 */
export function firstStrongDirection(text: string): Direction | null {
  let isolateDepth = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp === LRI || cp === RLI || cp === FSI) {
      isolateDepth++;
      continue;
    }
    if (cp === PDI) {
      if (isolateDepth > 0) isolateDepth--;
      continue;
    }
    if (isolateDepth > 0) continue;
    if (cp === RLM || cp === ALM) return 'rtl';
    if (cp === LRM) return 'ltr';
    if (LETTER.test(char)) return isRtlCodePoint(cp) ? 'rtl' : 'ltr';
  }
  return null;
}
