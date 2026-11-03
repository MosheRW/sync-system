import { describe, expect, it } from 'vitest';
import { normalizeDisplayName } from '../src/index.js';

/*
 * Display names by Unicode property, not by list (#10 B2). The oracle below
 * restates the rule independently of the implementation and is checked
 * against EVERY code point U+0000-U+10FFFF, including lone surrogates.
 */

/** General categories and properties a name may never contain. */
const FORBIDDEN_PROPERTY =
  /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]$/u;

/** Characters in visible categories that still render blank. */
const BLANK_LOOKING = new Set([0x2800, 0x115f, 0x1160, 0x3164, 0xffa0, 0x1d159]);

/** Visible: a letter, number, symbol or punctuation. */
const VISIBLE = /^[\p{L}\p{N}\p{S}\p{P}]$/u;

function isForbidden(cp: number, char: string): boolean {
  return FORBIDDEN_PROPERTY.test(char) || BLANK_LOOKING.has(cp);
}

function hex(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Every code point, as a one-code-point string (lone surrogates included). */
function* everyCodePoint(): Generator<[number, string]> {
  for (let cp = 0; cp <= 0x10ffff; cp++) yield [cp, String.fromCodePoint(cp)];
}

describe('normalizeDisplayName by Unicode property (#10 B2)', () => {
  it('rejects every forbidden code point alone and embedded, at every position', () => {
    const leaks: string[] = [];
    let checked = 0;
    for (const [cp, char] of everyCodePoint()) {
      if (!isForbidden(cp, char)) continue;
      checked++;
      // Alone and inside a name: always rejected.
      for (const name of [char, `a${char}b`, `Da ${char} na`, `${char}${char}`]) {
        if (normalizeDisplayName(name) !== undefined) {
          leaks.push(`${hex(cp)} in ${JSON.stringify(name)}`);
        }
      }
      // At either end: rejected, or removed by trim (line breaks, U+FEFF);
      // an accepted name never contains it.
      for (const name of [`${char}Dana`, `Dana${char}`]) {
        const result = normalizeDisplayName(name);
        if (result !== undefined && result !== 'Dana') {
          leaks.push(`${hex(cp)} in ${JSON.stringify(name)}`);
        }
      }
      if (leaks.length > 20) break;
    }
    expect(leaks).toEqual([]);
    // Sanity check of the oracle: Cn and Co alone are over 900,000 code points.
    expect(checked).toBeGreaterThan(900_000);
  }, 60_000);

  it('accepts every other code point embedded between letters', () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const [cp, char] of everyCodePoint()) {
      if (isForbidden(cp, char)) continue;
      checked++;
      const name = `a${char}b`;
      if (normalizeDisplayName(name) !== name) wrong.push(hex(cp));
      if (wrong.length > 20) break;
    }
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(150_000);
  }, 60_000);

  it('accepts a code point alone exactly when it is visible and allowed', () => {
    const wrong: string[] = [];
    for (const [cp, char] of everyCodePoint()) {
      const expected = !isForbidden(cp, char) && VISIBLE.test(char) ? char : undefined;
      if (normalizeDisplayName(char) !== expected) wrong.push(hex(cp));
      if (wrong.length > 20) break;
    }
    expect(wrong).toEqual([]);
  }, 60_000);

  it('rejects names made only of non-visible code points', () => {
    // Every code point that is not forbidden but not visible either
    // (whitespace, combining marks), plus the emoji sequence parts.
    const pool: string[] = ['‍', '︎', '️', '\u{E0067}', '\u{E007F}', '⃣'];
    for (const [cp, char] of everyCodePoint()) {
      if (!isForbidden(cp, char) && !VISIBLE.test(char)) pool.push(char);
    }
    expect(pool.length).toBeGreaterThan(2_000);
    // Deterministic pseudo-random names of 1 to 12 code points from the pool.
    let seed = 0x2545f491;
    const next = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x1_0000_0000;
    };
    const accepted: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const length = 1 + Math.floor(next() * 12);
      let name = '';
      for (let j = 0; j < length; j++) name += pool[Math.floor(next() * pool.length)];
      if (normalizeDisplayName(name) !== undefined) accepted.push(JSON.stringify(name));
    }
    expect(accepted).toEqual([]);
    for (const name of [
      '‍',
      '️',
      '︎',
      '‍️‍',
      '\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
      '\u{E007F}',
      '\u{E0001}',
      '⃣',
      '️⃣',
      '́́́',
      '　́',
    ]) {
      expect(normalizeDisplayName(name), JSON.stringify(name)).toBeUndefined();
    }
  });

  it.each([
    ['U+034F combining grapheme joiner', '͏'],
    ['U+1160 Hangul jungseong filler', 'ᅠ'],
    ['U+17B4 Khmer vowel inherent aq', '឴'],
    ['U+17B5 Khmer vowel inherent aa', '឵'],
    ['U+180B Mongolian free variation selector one', '᠋'],
    ['U+180F Mongolian free variation selector four', '᠏'],
    ['U+200C zero width non-joiner', '‌'],
    ['U+206A inhibit symmetric swapping', '⁪'],
    ['U+206F nominal digit shapes', '⁯'],
    ['U+FE00 variation selector 1', '︀'],
    ['U+FE0F variation selector 16 alone', '️'],
    ['U+E0001 language tag', '\u{E0001}'],
    ['U+E0067 lone tag character', '\u{E0067}'],
    ['U+E007F lone cancel tag', '\u{E007F}'],
    ['U+1D173 musical symbol begin beam', '\u{1D173}'],
    ['U+1D17A musical symbol end phrase', '\u{1D17A}'],
    ['U+1BCA0 shorthand format letter overlap', '\u{1BCA0}'],
    ['U+FFF9 interlinear annotation anchor', '￹'],
    ['U+FFFB interlinear annotation terminator', '￻'],
    ['U+2800 braille pattern blank', '⠀'],
    ['U+1D159 musical symbol null notehead', '\u{1D159}'],
  ])('rejects %s (security review B2)', (_label, char) => {
    expect(normalizeDisplayName(char)).toBeUndefined();
    expect(normalizeDisplayName(`a${char}b`)).toBeUndefined();
    expect(normalizeDisplayName(`Dana${char}`)).toBeUndefined();
    expect(normalizeDisplayName(char.repeat(3))).toBeUndefined();
  });

  it('allows ZWJ, presentation selectors and tags only inside emoji sequences', () => {
    for (const bad of [
      'a‍b', // ZWJ between letters
      '‍\u{1F600}', // leading ZWJ
      '\u{1F600}‍', // trailing ZWJ
      '\u{1F600}‍‍\u{1F600}', // doubled ZWJ
      '\u{1F600} ‍\u{1F600}', // ZWJ after a space
      'a️', // presentation selector after a letter
      '\u{1F600}️️', // doubled selector
      'a\u{E0067}\u{E007F}', // tags after a letter
      '\u{1F3F4}\u{E0067}\u{E0062}', // tags without the cancel tag
      '\u{1F3F4}\u{E007F}', // cancel tag without a tag
      '\u{1F3F4}\u{E0067}\u{E007F}\u{E007F}', // extra cancel tag
    ]) {
      expect(normalizeDisplayName(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it.each([
    ['Latin', 'Dana Cohen'],
    ['accented Latin', 'José Zoë Ångström'],
    ['Hebrew', 'משה וינברג'],
    ['Hebrew with niqqud', 'מֹשֶׁה'],
    ['Arabic', 'محمد علي'],
    ['CJK', '李小龙'],
    ['Japanese', 'さくら'],
    ['Korean', '김민수'],
    ['Devanagari', 'क्षत्रिय'],
    ['Cyrillic', 'Наташа'],
    ['Greek', 'Ελένη'],
    ['Thai', 'สมชาย'],
    ['digits and punctuation', "O'Brien-Smith 2"],
    ['emoji', '\u{1F642}'],
    ['ZWJ family', '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'],
    ['flag', '\u{1F1EE}\u{1F1F1}'],
    ['skin tone', '\u{1F44D}\u{1F3FD}'],
    ['skin tone with ZWJ', '\u{1F469}\u{1F3FD}‍\u{1F4BB}'],
    ['keycap one', '1️⃣'],
    ['keycap hash', '#️⃣'],
    ['England tag flag', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'],
    ['Scotland tag flag', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'],
    ['rainbow flag', '\u{1F3F3}️‍\u{1F308}'],
    ['transgender flag', '\u{1F3F3}️‍⚧️'],
    ['heart on fire', '❤️‍\u{1F525}'],
    ['polar bear', '\u{1F43B}‍❄️'],
    ['man with beard', '\u{1F9D4}‍♂️'],
    ['text presentation', '☺︎'],
    ['name with emoji', 'Dana \u{1F468}‍\u{1F469}‍\u{1F467}'],
  ])('accepts a %s name', (_label, name) => {
    expect(normalizeDisplayName(name)).toBe(name);
    expect(normalizeDisplayName(`  ${name}  `)).toBe(name);
  });

  it('keeps the trim and length rules', () => {
    expect(normalizeDisplayName(' 　Dana  ')).toBe('Dana');
    expect(normalizeDisplayName('\u{1F642}'.repeat(32))).toBe('\u{1F642}'.repeat(32));
    expect(normalizeDisplayName('\u{1F642}'.repeat(33))).toBeUndefined();
    expect(normalizeDisplayName('a'.repeat(129))).toBeUndefined();
  });
});
