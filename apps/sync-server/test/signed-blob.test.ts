import * as crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  hasExactKeys,
  isClaimInteger,
  parseCompactPayload,
  signCompact,
  verifyCompact,
} from '../src/tokens/signed-blob.js';

const KEY = Buffer.alloc(32, 1);
const OTHER = Buffer.alloc(32, 2);

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

describe('signCompact / verifyCompact (#10 D2, R5)', () => {
  it('round-trips an ASCII payload and reports the matching key', () => {
    const signed = signCompact('{"v":1}', KEY);
    expect(signed).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(verifyCompact(signed, [KEY], 512)).toEqual({ payloadJson: '{"v":1}', keyIndex: 0 });
    expect(verifyCompact(signed, [OTHER, KEY], 512)).toEqual({
      payloadJson: '{"v":1}',
      keyIndex: 1,
    });
  });

  it('rejects a wrong key, a changed payload or signature, and other shapes', () => {
    const signed = signCompact('{"v":1}', KEY);
    const [payload, signature] = signed.split('.') as [string, string];
    expect(verifyCompact(signed, [OTHER], 512)).toBeUndefined();
    expect(verifyCompact(`${payload}A.${signature}`, [KEY], 512)).toBeUndefined();
    const flipped = signature.startsWith('A') ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
    expect(verifyCompact(`${payload}.${flipped}`, [KEY], 512)).toBeUndefined();
    for (const bad of [
      undefined,
      42,
      '',
      payload,
      `${payload}.${signature}.x`,
      `${payload}.${signature}A`,
      `${payload}.${signature.slice(1)}`,
      `${payload}=.${signature}`,
      `.${signature}`,
      `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${signed}`,
    ]) {
      expect(verifyCompact(bad, [KEY], 512)).toBeUndefined();
    }
  });

  it('checks the length before anything else', () => {
    const signed = signCompact('{"v":1}', KEY);
    expect(verifyCompact(signed, [KEY], signed.length)).toBeDefined();
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();
    expect(verifyCompact(signed, [KEY], signed.length - 1)).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('compares against every key, even after a match', () => {
    const signed = signCompact('{"v":1}', KEY);
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();
    verifyCompact(signed, [KEY, OTHER], 512);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('rejects a correctly signed non-ASCII payload', () => {
    const signed = signCompact('{"v":"\u00E9"}', KEY);
    expect(verifyCompact(signed, [KEY], 512)).toBeUndefined();
  });
});

describe('claim helpers', () => {
  it('parses only plain JSON objects, never throwing', () => {
    expect(parseCompactPayload('{"a":1}')).toEqual({ a: 1 });
    for (const bad of ['', '[1]', 'null', '1', '"x"', '{', '{"a":']) {
      expect(parseCompactPayload(bad)).toBeUndefined();
    }
  });

  it('accepts safe non-negative integers only', () => {
    expect(isClaimInteger(0)).toBe(true);
    expect(isClaimInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null, Number.NaN]) {
      expect(isClaimInteger(bad)).toBe(false);
    }
  });

  it('checks for exactly the expected keys', () => {
    expect(hasExactKeys({ a: 1, b: 2 }, ['a', 'b'])).toBe(true);
    expect(hasExactKeys({ a: 1 }, ['a', 'b'])).toBe(false);
    expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ['a', 'b'])).toBe(false);
  });
});
