import { describe, expect, it } from 'vitest';
import { blockDir, documentDir, effectiveLang, pageDir } from '../src/direction/effective.js';
import { firstStrongDirection } from '../src/direction/first-strong.js';

const LRM = '\u{200E}';
const RLM = '\u{200F}';
const ALM = '\u{061C}';
const LRI = '\u{2066}';
const RLI = '\u{2067}';
const FSI = '\u{2068}';
const PDI = '\u{2069}';

describe('firstStrongDirection (AC11, P3)', () => {
  it.each([
    ['Hebrew', 'שלום עולם', 'rtl'],
    ['Arabic', 'مرحبا بالعالم', 'rtl'],
    ['Syriac', 'ܫܠܡܐ', 'rtl'],
    ['Thaana', 'ދިވެހި', 'rtl'],
    ['Arabic presentation form', '\u{FEFB}', 'rtl'],
    ['Hebrew presentation form', '\u{FB2A}', 'rtl'],
    ['Adlam (SMP)', '\u{1E900}', 'rtl'],
    ['English', 'Hello world', 'ltr'],
    ['Greek', 'Καλημέρα', 'ltr'],
    ['CJK', '日本語', 'ltr'],
    ['mixed starting with Hebrew', 'שלום world', 'rtl'],
    ['mixed starting with English', 'Hello עולם', 'ltr'],
    ['digits then Hebrew', '1948 - מדינה', 'rtl'],
    ['punctuation then English', '"(1) Hello', 'ltr'],
    ['LRM first', `${LRM}שלום`, 'ltr'],
    ['RLM first', `${RLM}Hello`, 'rtl'],
    ['ALM first', `${ALM}Hello`, 'rtl'],
    ['isolate-wrapped first word', `${LRI}Hello${PDI} שלום`, 'rtl'],
    ['nested isolates', `${FSI}a${RLI}ב${PDI}c${PDI} עולם`, 'rtl'],
    ['unclosed isolate', `${RLI}שלום`, null],
  ] as const)('%s -> %s', (_name, text, expected) => {
    expect(firstStrongDirection(text)).toBe(expected);
  });

  it.each(['', '   ', '1948 - 2024.', '123', '?!', '\n\n', '— 42 —'])(
    'neutral-only %j gives null',
    (text) => {
      expect(firstStrongDirection(text)).toBeNull();
    },
  );
});

describe('effective direction (AC10)', () => {
  const block = (dir?: 'ltr' | 'rtl' | 'auto', text = 'x') =>
    dir === undefined ? { text } : { text, dir };

  it('defaults to ltr', () => {
    expect(documentDir({})).toBe('ltr');
    expect(pageDir({}, {})).toBe('ltr');
    expect(blockDir({}, {}, block())).toBe('ltr');
  });

  it('inherits block > page > document', () => {
    expect(blockDir({ dir: 'rtl' }, {}, block())).toBe('rtl');
    expect(blockDir({ dir: 'rtl' }, { dir: 'ltr' }, block())).toBe('ltr');
    expect(blockDir({ dir: 'ltr' }, { dir: 'ltr' }, block('rtl'))).toBe('rtl');
    expect(pageDir({ dir: 'rtl' }, { dir: 'ltr' })).toBe('ltr');
  });

  it('resolves auto from the text, falling back to the page direction', () => {
    expect(blockDir({ dir: 'rtl' }, {}, block('auto', 'Hello'))).toBe('ltr');
    expect(blockDir({ dir: 'ltr' }, {}, block('auto', 'שלום'))).toBe('rtl');
    expect(blockDir({ dir: 'rtl' }, {}, block('auto', '1948 - 2024.'))).toBe('rtl');
    expect(blockDir({ dir: 'rtl' }, { dir: 'ltr' }, block('auto', ''))).toBe('ltr');
    expect(blockDir({}, {}, block('auto', '...'))).toBe('ltr');
  });

  it('resolves lang block > page > document', () => {
    expect(effectiveLang({ lang: 'he' })).toBe('he');
    expect(effectiveLang({ lang: 'he' }, { lang: 'en' })).toBe('en');
    expect(effectiveLang({ lang: 'he' }, { lang: 'en' }, { lang: 'ar' })).toBe('ar');
    expect(effectiveLang({}, {}, {})).toBeUndefined();
  });
});
