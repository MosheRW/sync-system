import { describe, expect, it } from 'vitest';
import { delayCap, nextDelay } from '../src/backoff.js';

const policy = { initialDelayMs: 500, maxDelayMs: 10_000 };

describe('backoff (Q3, AC26)', () => {
  it('doubles the cap up to maxDelayMs', () => {
    const caps = [1, 2, 3, 4, 5, 6, 7, 20].map((n) => delayCap(n, policy));
    expect(caps).toEqual([500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
  });

  it('uses full jitter: random 1 gives the cap, 0 gives 0, 0.5 gives half', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => nextDelay(n, policy, () => 1))).toEqual([
      500, 1000, 2000, 4000, 8000, 10_000, 10_000,
    ]);
    expect([1, 2, 3, 10].map((n) => nextDelay(n, policy, () => 0))).toEqual([0, 0, 0, 0]);
    expect([1, 2, 3].map((n) => nextDelay(n, policy, () => 0.5))).toEqual([250, 500, 1000]);
  });

  it('never goes above the cap or below 0, even with a bad random source', () => {
    for (let n = 1; n < 40; n += 1) {
      const delay = nextDelay(n, policy, Math.random);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(10_000);
    }
    expect(nextDelay(3, policy, () => 7)).toBe(2000);
    expect(nextDelay(3, policy, () => -1)).toBe(0);
    expect(nextDelay(3, policy, () => Number.NaN)).toBe(0);
  });

  it('treats streak 0 like the first failure', () => {
    expect(delayCap(0, policy)).toBe(500);
  });
});
