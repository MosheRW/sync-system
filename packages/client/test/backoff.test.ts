import { describe, expect, it } from 'vitest';
import { delayCap, nextDelay, streakAfterDrop, streakAfterFailure } from '../src/backoff.js';

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

describe('busy-signal floor (M3) and 4003 cap (Q-E)', () => {
  it('starts close 1001, 4003 and 4008 with a 2 s cap, and 1006 with 0.5 s', () => {
    const one = () => 1;
    for (const signal of ['going_away', 'app_connection_limit', 'too_many_messages'] as const) {
      expect(nextDelay(streakAfterFailure(0, signal), policy, one, signal)).toBe(2000);
    }
    expect(nextDelay(streakAfterFailure(0), policy, one)).toBe(500);
  });

  it('never lowers a streak already above the floor', () => {
    expect(streakAfterFailure(5, 'going_away')).toBe(6);
    expect(streakAfterFailure(0, 'going_away')).toBe(3);
    expect(streakAfterFailure(2)).toBe(3);
  });

  it('caps APP_CONNECTION_LIMIT at 30 s and everything else at maxDelayMs', () => {
    expect(delayCap(10, policy, 'app_connection_limit')).toBe(30_000);
    expect(delayCap(10, policy, 'going_away')).toBe(10_000);
    expect(delayCap(10, { initialDelayMs: 500, maxDelayMs: 60_000 }, 'app_connection_limit')).toBe(
      60_000,
    );
  });
});

describe('stability rule (H1)', () => {
  it('resets the streak only after stableAfterMs connected', () => {
    expect(streakAfterDrop(4, 9_999, 10_000)).toBe(4);
    expect(streakAfterDrop(4, 10_000, 10_000)).toBe(0);
  });

  it('gives growing caps for a server that drops 100 ms after every handshake', () => {
    let streak = 0;
    const caps: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      streak = streakAfterFailure(streakAfterDrop(streak, 100, 10_000));
      caps.push(nextDelay(streak, policy, () => 1));
    }
    expect(caps).toEqual([500, 1000, 2000, 4000, 8000]);
  });
});
