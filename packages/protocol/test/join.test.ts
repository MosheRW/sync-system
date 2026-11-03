import { describe, expect, it } from 'vitest';
import {
  ALPHA_CODE_ALPHABET,
  CODES_BLOB_PATTERN,
  JOIN_METHODS,
  JOIN_REQUEST_ID_PATTERN,
  MAX_CODES_BLOB_LENGTH,
  MAX_QR_TICKET_LENGTH,
  QR_TICKET_PATTERN,
  classifyJoinCode,
  isCodesBlobShape,
  isDoorCode,
  isQrTicketShape,
  normalizeDisplayName,
  normalizeJoinCode,
} from '../src/index.js';

describe('join methods', () => {
  it('lists A to D in canonical order', () => {
    expect(JOIN_METHODS).toEqual(['A', 'B', 'C', 'D']);
  });
});

describe('alphanumeric alphabet (AC8)', () => {
  it('has 31 distinct characters and no look-alikes', () => {
    expect(ALPHA_CODE_ALPHABET).toHaveLength(31);
    expect(new Set(ALPHA_CODE_ALPHABET).size).toBe(31);
    for (const excluded of ['0', 'O', '1', 'I', 'L']) {
      expect(ALPHA_CODE_ALPHABET).not.toContain(excluded);
    }
    expect(ALPHA_CODE_ALPHABET).toMatch(/^[0-9A-Z]+$/);
  });
});

describe('normalizeJoinCode / classifyJoinCode (AC12)', () => {
  it('strips spaces and hyphens and uppercases letters', () => {
    expect(normalizeJoinCode(' 123-456 ')).toBe('123456');
    expect(normalizeJoinCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeJoinCode('a b-c')).toBe('ABC');
  });

  it('uppercases ASCII letters only', () => {
    expect(normalizeJoinCode('\u00DF')).toBe('\u00DF');
    expect(normalizeJoinCode('\tab')).toBe('\tAB');
  });

  it('classifies 6 digits as a group code and 8 alphabet characters as an alpha code', () => {
    expect(classifyJoinCode('000000')).toBe('group');
    expect(classifyJoinCode('123456')).toBe('group');
    expect(classifyJoinCode('ABCDEFGH')).toBe('alpha');
    expect(classifyJoinCode('23456789')).toBe('alpha');
    expect(classifyJoinCode(normalizeJoinCode('abcd-efgh'))).toBe('alpha');
  });

  it('rejects every other format', () => {
    for (const code of [
      '',
      '12345',
      '1234567',
      '12345678',
      'ABCDEFG0',
      'ABCDEFGO',
      'ABCDEFGI',
      'ABCDEFGL',
      'ABCDEFG',
      'ABCDEFGHJ',
      'abcdefgh',
      '\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16',
      '12 3456',
    ]) {
      expect(classifyJoinCode(code)).toBeUndefined();
    }
  });

  it('keeps over-long input unchanged so it never matches a format', () => {
    const long = '1'.repeat(33);
    expect(normalizeJoinCode(long)).toBe(long);
    expect(classifyJoinCode(normalizeJoinCode(long))).toBeUndefined();
  });

  it('checks door codes as 6 digits', () => {
    expect(isDoorCode('012345')).toBe(true);
    expect(isDoorCode('12345')).toBe(false);
    expect(isDoorCode('ABCDEF')).toBe(false);
  });
});

describe('normalizeDisplayName (AC20, R9)', () => {
  it('trims and accepts 1 to 32 code points', () => {
    expect(normalizeDisplayName('  Dana  ')).toBe('Dana');
    expect(normalizeDisplayName('x'.repeat(32))).toBe('x'.repeat(32));
    expect(normalizeDisplayName('\uD83D\uDE00'.repeat(32))).toBe('\uD83D\uDE00'.repeat(32));
  });

  it('rejects empty, blank and too long names', () => {
    expect(normalizeDisplayName('')).toBeUndefined();
    expect(normalizeDisplayName('   ')).toBeUndefined();
    expect(normalizeDisplayName('x'.repeat(33))).toBeUndefined();
    expect(normalizeDisplayName('\uD83D\uDE00'.repeat(33))).toBeUndefined();
    expect(normalizeDisplayName(' '.repeat(129))).toBeUndefined();
  });

  it('rejects control characters, separators and bidi controls', () => {
    for (const bad of [
      'a\u0000b',
      'a\nb',
      'a\u007fb',
      'a\u0085b',
      'a\u2028b',
      'a\u2029b',
      'a\u202Eb',
      'a\u202Ab',
      'a\u2066b',
      'a\u2069b',
    ]) {
      expect(normalizeDisplayName(bad)).toBeUndefined();
    }
  });

  it('rejects lone surrogates and invisible format characters (R9)', () => {
    for (const bad of [
      'a\ud800',
      '\ud800b',
      'a\udc00b',
      'a\u061Cb',
      'a\u200Bb',
      'a\u200Eb',
      'a\u200Fb',
      'a\uFEFFb',
    ]) {
      expect(normalizeDisplayName(bad)).toBeUndefined();
    }
  });

  it('accepts emoji sequences: ZWJ family, flags and tag sequences', () => {
    const family = '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67';
    const flag = '\uD83C\uDDEE\uD83C\uDDF1';
    const scotland = '\uD83C\uDFF4\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
    const heart = '\u2764\uFE0F';
    for (const name of [family, flag, scotland, heart, `Dana ${family}`]) {
      expect(normalizeDisplayName(name)).toBe(name);
    }
  });
});

describe('ticket, blob and request ID shapes', () => {
  const sig = 'A'.repeat(43);

  it('accepts the compact two-segment shape', () => {
    expect(QR_TICKET_PATTERN.test(`abc_-.${sig}`)).toBe(true);
    expect(CODES_BLOB_PATTERN.test(`abc.${sig}`)).toBe(true);
    expect(isQrTicketShape(`abc.${sig}`)).toBe(true);
    expect(isCodesBlobShape(`abc.${sig}`)).toBe(true);
  });

  it('rejects other shapes and over-long values', () => {
    expect(isQrTicketShape(`a.b.${sig}`)).toBe(false);
    expect(isQrTicketShape(`abc.${sig}A`)).toBe(false);
    expect(isQrTicketShape(`ab=.${sig}`)).toBe(false);
    expect(isQrTicketShape(42)).toBe(false);
    expect(isQrTicketShape(`${'a'.repeat(MAX_QR_TICKET_LENGTH - 43)}.${sig}`)).toBe(false);
    expect(isQrTicketShape(`${'a'.repeat(MAX_QR_TICKET_LENGTH - 44)}.${sig}`)).toBe(true);
    expect(isCodesBlobShape(`${'a'.repeat(MAX_CODES_BLOB_LENGTH - 43)}.${sig}`)).toBe(false);
    expect(isCodesBlobShape(`${'a'.repeat(MAX_CODES_BLOB_LENGTH - 44)}.${sig}`)).toBe(true);
  });

  it('accepts 22 base64url characters as a request ID', () => {
    expect(JOIN_REQUEST_ID_PATTERN.test('A'.repeat(22))).toBe(true);
    expect(JOIN_REQUEST_ID_PATTERN.test('A'.repeat(21))).toBe(false);
    expect(JOIN_REQUEST_ID_PATTERN.test(`${'A'.repeat(21)}=`)).toBe(false);
  });
});
