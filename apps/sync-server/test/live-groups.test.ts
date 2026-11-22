import { describe, expect, it } from 'vitest';
import {
  type BucketState,
  MAX_RETRY_AFTER_MS,
  MemoryLiveGroups,
  bucketStep,
} from '../src/groups/live-groups.js';

const G = (letter: string) => letter.repeat(43);
const T0 = 1_700_000_000_000;

describe('bucketStep (#12 3.1)', () => {
  const limits = { expiresAt: T0 + 60_000, burst: 3, refillPerMinute: 6 };

  it('starts full, charges one token and refills continuously', () => {
    const first = bucketStep(undefined, T0, limits);
    expect(first).toMatchObject({ ok: true, next: { t: 2, a: T0, r: 6, b: 3, u: T0 + 60_000 } });
    let state = (first as { next: BucketState }).next;
    for (const t of [1, 0]) {
      const step = bucketStep(state, T0, limits);
      expect(step).toMatchObject({ ok: true, next: { t } });
      state = (step as { next: BucketState }).next;
    }
    // 6 per minute: 10 s per token.
    expect(bucketStep(state, T0, limits)).toEqual({ ok: false, retryAfterMs: 10_000 });
    expect(bucketStep(state, T0 + 4_000, limits)).toEqual({ ok: false, retryAfterMs: 6_000 });
    expect(bucketStep(state, T0 + 10_000, limits)).toMatchObject({ ok: true, next: { t: 0 } });
    // Never more than the burst.
    expect(bucketStep(state, T0 + 3_600_000, limits)).toMatchObject({ ok: true, next: { t: 2 } });
  });

  it('never moves the charge time back on clock skew', () => {
    const state: BucketState = { t: 2, a: T0 + 5_000, r: 6, b: 3, u: T0 + 60_000 };
    const step = bucketStep(state, T0, limits);
    expect(step).toMatchObject({ ok: true, next: { t: 1, a: T0 + 5_000 } });
  });

  it('keeps the slowest rate and smallest burst until u, then takes the new ones (R13)', () => {
    const strict: BucketState = { t: 0, a: T0, r: 1, b: 1, u: T0 + 120_000 };
    const loose = { expiresAt: T0 + 30_000, burst: 10, refillPerMinute: 600 };
    // Before u: refilled at 1/min, at most 1 token, u kept at the later end.
    expect(bucketStep(strict, T0 + 30_000, loose)).toEqual({ ok: false, retryAfterMs: 30_000 });
    expect(bucketStep(strict, T0 + 90_000, loose)).toMatchObject({
      ok: true,
      next: { t: 0, r: 1, b: 1, u: T0 + 120_000 },
    });
    // After u: the caller's values.
    expect(bucketStep(strict, T0 + 120_000, loose)).toMatchObject({
      ok: true,
      next: { t: 9, r: 600, b: 10, u: T0 + 30_000 },
    });
  });

  it('gives a TTL of max(time to full, u - now) + 1 s, as an integer (R14)', () => {
    const step = bucketStep(undefined, T0, { expiresAt: T0 + 5_000, burst: 3, refillPerMinute: 7 });
    // One token at 7/min: 8571.4 ms, rounded up.
    expect(step).toMatchObject({ ok: true, ttlMs: 9_572 });
    const long = bucketStep(undefined, T0, { expiresAt: T0 + 6e16, burst: 1, refillPerMinute: 1 });
    expect(long).toMatchObject({ ok: true, ttlMs: MAX_RETRY_AFTER_MS });
  });

  it('clamps the wait to a safe integer at a tiny rate (R14, L8)', () => {
    const state: BucketState = { t: 0, a: T0, r: 1e-300, b: 1, u: T0 + 6e16 };
    expect(bucketStep(state, T0, { ...limits, refillPerMinute: 1e-300 })).toEqual({
      ok: false,
      retryAfterMs: MAX_RETRY_AFTER_MS,
    });
  });
});

describe('MemoryLiveGroups (#12 3.1)', () => {
  it('drops an app once it has no live group and an idle bucket (bounded state)', async () => {
    let time = T0;
    const store = new MemoryLiveGroups(() => time);
    const budget = { now: T0, expiresAt: T0 + 10_000, burst: 2, refillPerMinute: 60, cap: 5 };
    await store.reserve('app-a', G('A'), budget);
    await store.release('app-a', G('A'));
    // The strict values hold until u: the entry stays.
    expect(store.size).toBe(1);
    time = T0 + 10_000;
    await store.register('app-a', G('B'), T0 + 20_000);
    await store.release('app-a', G('B'));
    expect(store.size).toBe(0);
    store.clear();
    expect(store.count('app-a')).toBe(0);
  });

  it('clear forgets everything (shutdown)', async () => {
    const store = new MemoryLiveGroups(() => T0);
    await store.register('app-a', G('A'), T0 + 1_000);
    store.clear();
    expect(store.size).toBe(0);
  });
});
