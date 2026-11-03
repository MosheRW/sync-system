import * as crypto from 'node:crypto';
import type * as Crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { doorCodeMatches } from '../src/joins/codes.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

describe('doorCodeMatches (#10 AC15, R6)', () => {
  it('compares two validated 6-digit codes in constant time', () => {
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();
    expect(doorCodeMatches('012345', '012345')).toBe(true);
    expect(doorCodeMatches('012345', '012346')).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
    const [a, b] = spy.mock.calls[0]!;
    expect((a as Buffer).length).toBe(6);
    expect((b as Buffer).length).toBe(6);
  });

  it('never compares a value that is not exactly 6 digits', () => {
    const spy = vi.mocked(crypto.timingSafeEqual);
    spy.mockClear();
    for (const [presented, expected] of [
      ['12345', '012345'],
      ['0123456', '012345'],
      ['01234a', '012345'],
      ['012345', ''],
      ['', ''],
    ] as const) {
      expect(doorCodeMatches(presented, expected)).toBe(false);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
