import { describe, expect, it } from 'vitest';
import {
  MAX_TOKEN_LENGTH,
  NAMESPACE_PATTERN,
  PARTICIPANT_ID_PATTERN,
  base64UrlToAscii,
  decodeTokenClaims,
  splitToken,
} from '../src/index.js';

const HEADER = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
const SIG = 'A'.repeat(43);

const CLAIMS = {
  v: 1,
  aud: 'reading-app',
  gid: 'G'.repeat(43),
  pid: '0b6a3f5e-8c1d-4e2f-9a7b-1c2d3e4f5a6b',
  role: 'leader',
  gct: 1_767_225_600_000,
  lat: 1_767_226_800_000,
  iat: 1_767_226_800,
  exp: 1_767_226_800 + 31_536_000,
};

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function token(payload: unknown, header = HEADER, sig = SIG): string {
  return `${header}.${b64url(JSON.stringify(payload))}.${sig}`;
}

describe('base64UrlToAscii', () => {
  it('decodes base64url without padding like Buffer does', () => {
    for (const text of ['a', 'ab', 'abc', 'abcd', '{"v":1}', '~~~???>>>']) {
      expect(base64UrlToAscii(b64url(text))).toBe(text);
    }
  });

  it('rejects characters outside the alphabet and impossible lengths', () => {
    expect(base64UrlToAscii('ab+/')).toBeUndefined();
    expect(base64UrlToAscii('ab==')).toBeUndefined();
    expect(base64UrlToAscii('abcde')).toBeUndefined();
    expect(base64UrlToAscii('ab c')).toBeUndefined();
  });

  it('rejects non-ASCII bytes', () => {
    expect(base64UrlToAscii(b64url('é'))).toBeUndefined();
    expect(base64UrlToAscii(Buffer.from([0x80]).toString('base64url'))).toBeUndefined();
  });
});

describe('splitToken', () => {
  it('checks the length before anything else', () => {
    const long = `${HEADER}.${'a'.repeat(MAX_TOKEN_LENGTH)}.${SIG}`;
    expect(splitToken(long)).toBeUndefined();
  });

  it('needs exactly three base64url segments', () => {
    expect(splitToken(`${HEADER}.${SIG}`)).toBeUndefined();
    expect(splitToken(`${HEADER}.a.b.${SIG}`)).toBeUndefined();
    expect(splitToken(`${HEADER}..${SIG}`)).toBeUndefined();
    expect(splitToken(`${HEADER}.a=.${SIG}`)).toBeUndefined();
    expect(splitToken(42)).toBeUndefined();
    expect(splitToken(`${HEADER}.abc.${SIG}`)).toEqual([HEADER, 'abc', SIG]);
  });
});

describe('decodeTokenClaims', () => {
  it('returns the claims of a well-formed token', () => {
    expect(decodeTokenClaims(token(CLAIMS))).toEqual(CLAIMS);
  });

  it('ignores unknown extra claims and strips them', () => {
    const claims = decodeTokenClaims(token({ ...CLAIMS, codes: ['x'], extra: 1 }));
    expect(claims).toEqual(CLAIMS);
  });

  it('treats a __proto__ claim as an ignored unknown claim', () => {
    const json = JSON.stringify(CLAIMS).replace('{', '{"__proto__":{"polluted":true},');
    const claims = decodeTokenClaims(`${HEADER}.${b64url(json)}.${SIG}`);
    expect(claims).toEqual(CLAIMS);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(claims)).toBe(Object.prototype);
  });

  it('rejects every missing or wrongly typed claim', () => {
    for (const key of Object.keys(CLAIMS)) {
      const missing: Record<string, unknown> = { ...CLAIMS };
      delete missing[key];
      expect(decodeTokenClaims(token(missing)), `missing ${key}`).toBeUndefined();
      expect(decodeTokenClaims(token({ ...CLAIMS, [key]: [] })), `bad ${key}`).toBeUndefined();
    }
  });

  it('rejects an unknown format version, bad patterns and impossible times', () => {
    expect(decodeTokenClaims(token({ ...CLAIMS, v: 2 }))).toBeUndefined();
    expect(decodeTokenClaims(token({ ...CLAIMS, aud: 'Bad App' }))).toBeUndefined();
    expect(decodeTokenClaims(token({ ...CLAIMS, gid: 'short' }))).toBeUndefined();
    expect(decodeTokenClaims(token({ ...CLAIMS, pid: CLAIMS.pid.toUpperCase() }))).toBeUndefined();
    expect(decodeTokenClaims(token({ ...CLAIMS, role: 'admin' }))).toBeUndefined();
    expect(decodeTokenClaims(token({ ...CLAIMS, gct: 1.5 }))).toBeUndefined();
    expect(decodeTokenClaims(token({ ...CLAIMS, gct: -1 }))).toBeUndefined();
    expect(decodeTokenClaims(token({ ...CLAIMS, lat: CLAIMS.gct - 1 }))).toBeUndefined();
    expect(decodeTokenClaims(token({ ...CLAIMS, exp: CLAIMS.iat }))).toBeUndefined();
    expect(decodeTokenClaims(token({ ...CLAIMS, exp: 2 ** 60 }))).toBeUndefined();
  });

  it('rejects payloads that are not a JSON object of claims', () => {
    expect(decodeTokenClaims(`${HEADER}.${b64url('not json')}.${SIG}`)).toBeUndefined();
    expect(decodeTokenClaims(token([CLAIMS]))).toBeUndefined();
    expect(decodeTokenClaims(token({ ...CLAIMS, x: [[[[[1]]]]] }))).toBeUndefined();
    expect(decodeTokenClaims('garbage')).toBeUndefined();
    expect(decodeTokenClaims(undefined)).toBeUndefined();
  });
});

describe('patterns', () => {
  it('participant IDs are lowercase UUID v4', () => {
    expect(PARTICIPANT_ID_PATTERN.test(CLAIMS.pid)).toBe(true);
    expect(PARTICIPANT_ID_PATTERN.test(crypto.randomUUID())).toBe(true);
    expect(PARTICIPANT_ID_PATTERN.test('participant-1')).toBe(false);
    expect(PARTICIPANT_ID_PATTERN.test('0b6a3f5e-8c1d-1e2f-9a7b-1c2d3e4f5a6b')).toBe(false);
  });

  it('namespaces match the apps-config rule', () => {
    expect(NAMESPACE_PATTERN.test('reading-app')).toBe(true);
    expect(NAMESPACE_PATTERN.test('a'.repeat(63))).toBe(true);
    expect(NAMESPACE_PATTERN.test('a'.repeat(64))).toBe(false);
    expect(NAMESPACE_PATTERN.test('-x')).toBe(false);
  });
});
