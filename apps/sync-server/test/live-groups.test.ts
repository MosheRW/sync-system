import { describe, expect, it } from 'vitest';
import {
  type BucketState,
  MAX_RETRY_AFTER_MS,
  MemoryLiveGroups,
  bucketStep,
} from '../src/groups/live-groups.js';
import {
  DEFAULT_GROUP_CREATES_PER_APP_PER_MINUTE,
  DEFAULT_GROUP_CREATES_PER_CONNECTION_PER_MINUTE,
  DEFAULT_GROUP_CREATE_BURST_PER_APP,
  DEFAULT_MAX_LIVE_GROUPS_PER_APP,
  END_TTL_SLACK_MS,
  type GroupCreateLimits,
  MAX_GROUP_CREATES_PER_APP_PER_MINUTE_LIMIT,
  MAX_LIVE_GROUPS_PER_APP_LIMIT,
  appCreateRefillPerMinute,
} from '../src/limits/constants.js';

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

  it('gives a TTL of u - now + 1 ms, as an integer (R14, #47)', () => {
    const step = bucketStep(undefined, T0, { expiresAt: T0 + 5_000, burst: 3, refillPerMinute: 7 });
    // Not the time to full (one token at 7/min: 8 572 ms): the bucket ends
    // 1 ms after the app's latest group.
    expect(step).toMatchObject({ ok: true, ttlMs: 5_001 });
    const long = bucketStep(undefined, T0, { expiresAt: T0 + 6e16, burst: 1, refillPerMinute: 1 });
    expect(long).toMatchObject({ ok: true, ttlMs: MAX_RETRY_AFTER_MS });
  });

  it('ends the bucket with the last group of the app when burst > rate x L (#47 AC1)', () => {
    // cap 12, burst 4 (above cap / 4), the derived rate for 60 min: 2 per L.
    const limits = { appBurst: 4, appMaxPerMinute: 120, maxLiveGroups: 12 };
    const refillPerMinute = appCreateRefillPerMinute(limits, 60);
    const lifeMs = lifetime(60) * 60_000;
    let state: BucketState | undefined;
    let ttlMs = 0;
    for (let i = 0; i < 4; i += 1) {
      const step = bucketStep(state, T0, { expiresAt: T0 + lifeMs, burst: 4, refillPerMinute });
      expect(step.ok).toBe(true);
      ({ next: state, ttlMs } = step as { next: BucketState; ttlMs: number });
    }
    // Time to full is about 2 L; the bucket still ends 1 ms after u.
    const toFull = (4 * 60_000) / refillPerMinute;
    expect(toFull).toBeGreaterThan(1.9 * lifeMs);
    expect(ttlMs).toBe(Math.ceil(lifeMs) + 1);
    expect(ttlMs).toBeLessThanOrEqual(state!.u - T0 + 1);
  });

  it('ends the bucket at u + 1 ms when the per-minute bound is below the derived rate (#47 L1)', () => {
    // burst 120 at 1 per minute, 60 min: time to full 120 min > L.
    const limits = { appBurst: 120, appMaxPerMinute: 1, maxLiveGroups: 10_000 };
    const refillPerMinute = appCreateRefillPerMinute(limits, 60);
    expect(refillPerMinute).toBe(1);
    const lifeMs = lifetime(60) * 60_000;
    const budget = { expiresAt: T0 + lifeMs, burst: 120, refillPerMinute };
    let state: BucketState | undefined;
    let ttlMs = 0;
    // The whole burst at once: 120 min to full again, longer than L.
    for (let i = 0; i < 120; i += 1) {
      const step = bucketStep(state, T0, budget);
      expect(step.ok).toBe(true);
      ({ next: state, ttlMs } = step as { next: BucketState; ttlMs: number });
    }
    expect(state!.t).toBe(0);
    expect((120 * 60_000) / refillPerMinute).toBeGreaterThan(lifeMs);
    expect(ttlMs).toBe(Math.ceil(lifeMs) + 1);
  });

  it('keeps the bucket at u and drops it 1 ms later (#47 AC1 boundary)', () => {
    const step = bucketStep(undefined, T0, {
      expiresAt: T0 + 5_000.5,
      burst: 3,
      refillPerMinute: 1,
    });
    // ceil(u) + 1 from now: kept through now == ceil(u).
    expect(step).toMatchObject({ ok: true, ttlMs: 5_002 });
    // u in the past: at least 1 ms.
    const past = bucketStep(undefined, T0, { expiresAt: T0 - 10, burst: 3, refillPerMinute: 1 });
    expect(past).toMatchObject({ ok: true, ttlMs: 1 });
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

  it('keeps the bucket at its end bound and refills it only after (#47 AC1, H1)', async () => {
    // cap 12, burst 5, the derived rate: rate x L = 1 token.
    const limits = { appBurst: 5, appMaxPerMinute: 120, maxLiveGroups: 12 };
    const refillPerMinute = appCreateRefillPerMinute(limits, 60);
    const lifeMs = lifetime(60) * 60_000;
    let time = T0;
    const store = new MemoryLiveGroups(() => time);
    const reserve = (ns: string, id: string) =>
      store.reserve(ns, id, {
        now: time,
        expiresAt: time + lifeMs,
        burst: 5,
        refillPerMinute,
        cap: 12,
      });
    const ids = (letter: string) => [0, 1, 2, 3, 4].map((i) => `${letter}${i}`.padEnd(43, 'x'));
    for (const id of ids('a')) expect(await reserve('app-a', id)).toEqual({ ok: true });
    for (const id of ids('b')) expect(await reserve('app-b', id)).toEqual({ ok: true });
    // Exactly at u: the T0 groups still count and the bucket is kept, so
    // only rate x L = 1 more is admitted, not a fresh burst.
    time = T0 + lifeMs;
    const atEnd = [];
    for (const id of ids('c')) atEnd.push(await reserve('app-a', id));
    expect(atEnd.filter((r) => r.ok)).toHaveLength(1);
    expect(atEnd.filter((r) => !r.ok && r.reason === 'rate')).toHaveLength(4);
    expect(store.count('app-a')).toBe(6);
    expect(store.count('app-a')).toBeLessThanOrEqual(12 / 2);
    // Idle past u + 1 ms: the bucket is gone, a full burst is back, and
    // every group it charged has ended.
    time = T0 + Math.ceil(lifeMs) + 1;
    for (const id of ids('d')) expect(await reserve('app-b', id)).toEqual({ ok: true });
    expect(store.count('app-b')).toBe(5);
  });

  it('forgets an app once its bucket has ended, even before it is full (#47)', async () => {
    let time = T0;
    const store = new MemoryLiveGroups(() => time);
    // 1 per minute: full again only after 2 min, but the group ends at 10 s.
    const budget = { now: T0, expiresAt: T0 + 10_000, burst: 2, refillPerMinute: 1, cap: 5 };
    await store.reserve('app-a', G('A'), budget);
    await store.reserve('app-a', G('B'), budget);
    await store.release('app-a', G('A'));
    await store.release('app-a', G('B'));
    expect(store.size).toBe(1);
    time = T0 + 10_001;
    await store.register('app-a', G('C'), T0 + 20_000);
    await store.release('app-a', G('C'));
    expect(store.size).toBe(0);
  });

  it('clear forgets everything (shutdown)', async () => {
    const store = new MemoryLiveGroups(() => T0);
    await store.register('app-a', G('A'), T0 + 1_000);
    store.clear();
    expect(store.size).toBe(0);
  });
});

const DEFAULT_LIMITS: GroupCreateLimits = {
  perConnectionPerMinute: DEFAULT_GROUP_CREATES_PER_CONNECTION_PER_MINUTE,
  appBurst: DEFAULT_GROUP_CREATE_BURST_PER_APP,
  appMaxPerMinute: DEFAULT_GROUP_CREATES_PER_APP_PER_MINUTE,
  maxLiveGroups: DEFAULT_MAX_LIVE_GROUPS_PER_APP,
};

/** The configured extremes of architecture.md section 7 (R1, R3.5). */
const EXTREMES: Record<string, GroupCreateLimits> = {
  defaults: DEFAULT_LIMITS,
  smallest: { perConnectionPerMinute: 1, appBurst: 1, appMaxPerMinute: 1, maxLiveGroups: 3 },
  'tightest headroom': {
    ...DEFAULT_LIMITS,
    appBurst: 49_999,
    maxLiveGroups: MAX_LIVE_GROUPS_PER_APP_LIMIT,
  },
  'widest headroom': {
    ...DEFAULT_LIMITS,
    appBurst: 1,
    appMaxPerMinute: MAX_GROUP_CREATES_PER_APP_PER_MINUTE_LIMIT,
    maxLiveGroups: MAX_LIVE_GROUPS_PER_APP_LIMIT,
  },
  'rate bound 1': { ...DEFAULT_LIMITS, appMaxPerMinute: 1 },
};

/** The longest a group lives, in minutes: max session plus the end slack. */
const lifetime = (maxSessionMinutes: number) => maxSessionMinutes + END_TTL_SLACK_MS / 60_000;

describe('appCreateRefillPerMinute: the H1 inequality (#12 R1)', () => {
  it('matches the documented rates at the defaults', () => {
    const at = (m: number) => appCreateRefillPerMinute(DEFAULT_LIMITS, m);
    expect(at(40)).toBe(120);
    expect(at(41)).toBeCloseTo(118.8, 1);
    expect(at(60)).toBeCloseTo(81.2, 1);
    expect(at(180)).toBeCloseTo(27.1, 1);
    expect(at(480)).toBeCloseTo(10.2, 1);
    expect(at(10_080)).toBeCloseTo(0.48, 2);
  });

  for (const [label, limits] of Object.entries(EXTREMES)) {
    it(`keeps burst + rate x L <= cap / 2: ${label}`, () => {
      for (const m of [1, 40, 41, 180, 480, 10_080, 1e7]) {
        const rate = appCreateRefillPerMinute(limits, m);
        expect(rate, `${m}`).toBeGreaterThan(0);
        expect(rate, `${m}`).toBeLessThanOrEqual(limits.appMaxPerMinute);
        const admitted = limits.appBurst + rate * lifetime(m);
        expect(admitted, `${m}`).toBeLessThanOrEqual((limits.maxLiveGroups / 2) * (1 + 1e-9));
      }
    });
  }

  it('throws when the cap is not above twice the burst', () => {
    expect(() =>
      appCreateRefillPerMinute({ appBurst: 120, appMaxPerMinute: 120, maxLiveGroups: 240 }, 180),
    ).toThrow(RangeError);
    expect(() =>
      appCreateRefillPerMinute({ appBurst: 120, appMaxPerMinute: 120, maxLiveGroups: 241 }, 180),
    ).not.toThrow();
  });
});

/**
 * Worst case for H1 (#12 R1, L9, L11): a script reserves as fast as the
 * bucket allows for two group lifetimes and never releases (any keep-alive
 * holds a group until max session). Creates alone never fill the cap.
 */
describe('H1 simulation on MemoryLiveGroups (#12 R1)', () => {
  async function flood(
    limits: GroupCreateLimits,
    maxSessionMinutes: number,
    resetAtFraction?: number,
  ): Promise<{ peak: number; capRefusals: number; admitted: number }> {
    const T0 = 1_700_000_000_000;
    let time = T0;
    let store = new MemoryLiveGroups(() => time);
    const lifeMs = maxSessionMinutes * 60_000 + END_TTL_SLACK_MS;
    const end = T0 + 2 * lifeMs;
    const resetAt = resetAtFraction === undefined ? undefined : T0 + resetAtFraction * lifeMs;
    const refillPerMinute = appCreateRefillPerMinute(limits, maxSessionMinutes);
    // The groups the script holds, by end bound (in creation order).
    const ends: number[] = [];
    let head = 0;
    let peak = 0;
    let capRefusals = 0;
    let seq = 0;
    let reset = false;
    while (time <= end) {
      if (resetAt !== undefined && !reset && time >= resetAt) {
        // An epoch change: the bucket starts full again, the live groups recreate.
        reset = true;
        store = new MemoryLiveGroups(() => time);
        for (let i = head; i < ends.length; i += 1) {
          if (ends[i]! >= time) await store.register('app-a', groupIdOf(i), ends[i]!);
        }
      }
      const result = await store.reserve('app-a', groupIdOf(seq), {
        now: time,
        expiresAt: time + lifeMs,
        burst: limits.appBurst,
        refillPerMinute,
        cap: limits.maxLiveGroups,
      });
      if (result.ok) {
        ends.push(time + lifeMs);
        seq += 1;
        while (head < ends.length && ends[head]! < time) head += 1;
        peak = Math.max(peak, ends.length - head);
      } else if (result.reason === 'cap') {
        capRefusals += 1;
        time += 1_000;
      } else {
        time += result.retryAfterMs;
      }
    }
    expect(store.count('app-a')).toBeLessThanOrEqual(peak);
    return { peak, capRefusals, admitted: seq };
  }

  /** A distinct valid group ID per index. */
  function groupIdOf(i: number): string {
    return i.toString(36).toUpperCase().padStart(43, '0');
  }

  const CASES: Array<[string, GroupCreateLimits, number]> = [
    ['defaults at 180 min', DEFAULT_LIMITS, 180],
    ['defaults at 480 min', DEFAULT_LIMITS, 480],
    ['cap 3, burst 1 at 180 min', EXTREMES.smallest!, 180],
    ['cap 100 000, burst 1, rate bound 60 000 at 180 min', EXTREMES['widest headroom']!, 180],
    // #47: a retry lands exactly on u; the bucket must still be there.
    ['cap 100 000, burst 49 999 at 180 min', EXTREMES['tightest headroom']!, 180],
    // #47 L1: burst > rate x L through the per-minute bound, not the cap.
    ['rate bound 1 at 60 min', EXTREMES['rate bound 1']!, 60],
  ];

  for (const [label, limits, minutes] of CASES) {
    it(`holds at most cap / 2 and never meets the cap: ${label}`, async () => {
      const { peak, capRefusals, admitted } = await flood(limits, minutes);
      expect(admitted).toBeGreaterThan(limits.appBurst);
      expect(peak).toBeLessThanOrEqual(Math.floor(limits.maxLiveGroups / 2));
      expect(capRefusals).toBe(0);
    });
  }

  const RESETS: Array<[string, GroupCreateLimits, number]> = [
    ['defaults at 180 min', DEFAULT_LIMITS, 180],
    ['cap 100 000, burst 49 999 at 180 min (L11)', EXTREMES['tightest headroom']!, 180],
  ];

  for (const [label, limits, minutes] of RESETS) {
    it(`after a reset holds at most cap / 2 + burst (L9): ${label}`, async () => {
      const { peak, capRefusals } = await flood(limits, minutes, 1.5);
      expect(peak).toBeLessThanOrEqual(Math.floor(limits.maxLiveGroups / 2) + limits.appBurst);
      expect(peak).toBeLessThan(limits.maxLiveGroups);
      expect(capRefusals).toBe(0);
    });
  }
});
