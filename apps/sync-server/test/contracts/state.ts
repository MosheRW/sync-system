import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EndedGroupsStore } from '../../src/groups/ended-groups.js';
import type { CodeIndexStore } from '../../src/joins/code-index.js';
import type { DoorStateStore } from '../../src/joins/door-guard.js';
import {
  type CreateBudget,
  type LiveGroupsStore,
  MAX_RETRY_AFTER_MS,
} from '../../src/groups/live-groups.js';

/**
 * Contract suites of the code index, the ended groups and the door state
 * (#35 AC29): the memory and Redis implementations pass the same tests.
 */

const G1 = 'A'.repeat(43);
const G2 = 'B'.repeat(43);
const FAR = Number.MAX_SAFE_INTEGER;

export interface CodeIndexHarness {
  make(): Promise<{ index: CodeIndexStore; count: () => Promise<number> }>;
  cleanup?(): Promise<void>;
}

export function codeIndexContract(label: string, harness: CodeIndexHarness): void {
  describe(`CodeIndex contract: ${label} (#10 AC9, AC11, AC13, R14)`, () => {
    let index: CodeIndexStore;
    let count: () => Promise<number>;
    beforeEach(async () => {
      ({ index, count } = await harness.make());
    });
    afterEach(async () => {
      await harness.cleanup?.();
    });

    it('looks codes up per app and per kind', async () => {
      expect(
        await index.claim('app-a', G1, { groupCode: '123456', alphaCode: 'ABCDEFGH' }, FAR),
      ).toBe(true);
      expect(await index.lookup('app-a', 'group', '123456')).toBe(G1);
      expect(await index.lookup('app-a', 'alpha', 'ABCDEFGH')).toBe(G1);
      expect(await index.lookup('app-b', 'group', '123456')).toBeUndefined();
      expect(await index.isFree('app-a', 'group', '123456')).toBe(false);
      expect(await index.isFree('app-b', 'group', '123456')).toBe(true);
      expect(await count()).toBe(2);
    });

    it('allows the same code in two apps at once', async () => {
      expect(await index.claim('app-a', G1, { groupCode: '123456' }, FAR)).toBe(true);
      expect(await index.claim('app-b', G2, { groupCode: '123456' }, FAR)).toBe(true);
      expect(await index.lookup('app-a', 'group', '123456')).toBe(G1);
      expect(await index.lookup('app-b', 'group', '123456')).toBe(G2);
    });

    it('claims all codes or none, and a held code is free for its group', async () => {
      await index.claim('app-a', G1, { alphaCode: 'ABCDEFGH' }, FAR);
      expect(
        await index.claim('app-a', G2, { groupCode: '123456', alphaCode: 'ABCDEFGH' }, FAR),
      ).toBe(false);
      expect(await index.lookup('app-a', 'group', '123456')).toBeUndefined();
      expect(await count()).toBe(1);
      expect(
        await index.claim('app-a', G1, { groupCode: '123456', alphaCode: 'ABCDEFGH' }, FAR),
      ).toBe(true);
      expect(await count()).toBe(2);
    });

    it('releases only codes the group still holds', async () => {
      await index.claim('app-a', G1, { groupCode: '123456' }, FAR);
      await index.release('app-a', G2, { groupCode: '123456' });
      expect(await index.lookup('app-a', 'group', '123456')).toBe(G1);
      await index.release('app-a', G1, { groupCode: '123456', alphaCode: 'ZZZZZZZZ' });
      expect(await index.lookup('app-a', 'group', '123456')).toBeUndefined();
      expect(await count()).toBe(0);
    });
  });
}

export interface EndedHarness {
  make(cap?: number): Promise<{
    ended: EndedGroupsStore;
    warnings: object[];
    advance: (ms: number) => void;
    size: () => Promise<number>;
  }>;
  cleanup?(): Promise<void>;
}

export function endedGroupsContract(label: string, harness: EndedHarness): void {
  describe(`EndedGroups contract: ${label} (Q8, L4, #13 6.9, RC17, RC20)`, () => {
    afterEach(async () => {
      await harness.cleanup?.();
    });

    it('remembers a group until its deadline, per namespace', async () => {
      const { ended, advance, size } = await harness.make();
      await ended.remember('app-a', 'g1', 2_000);
      expect(await ended.has('app-a', 'g1')).toBe(true);
      expect(await ended.has('app-b', 'g1')).toBe(false);
      expect(await ended.has('app-a', 'g2')).toBe(false);
      advance(999);
      expect(await ended.has('app-a', 'g1')).toBe(true);
      advance(1);
      expect(await ended.has('app-a', 'g1')).toBe(false);
      await ended.sweep();
      expect(await size()).toBe(0);
    });

    it('ignores a deadline that has already passed', async () => {
      const { ended, size } = await harness.make();
      await ended.remember('app-a', 'g1', 1_000);
      expect(await size()).toBe(0);
    });

    it('sweeps expired refs', async () => {
      const { ended, advance, size } = await harness.make();
      await ended.remember('app-a', 'short', 1_500);
      await ended.remember('app-a', 'long', 9_000);
      advance(600);
      await ended.sweep();
      expect(await size()).toBe(1);
      expect(await ended.has('app-a', 'long')).toBe(true);
    });

    it('evicts the oldest at the cap and warns with a count at most once a minute', async () => {
      const { ended, warnings, advance, size } = await harness.make(3);
      for (const id of ['a', 'b', 'c', 'd']) await ended.remember('app-a', id, 99_000);
      expect(await size()).toBe(3);
      expect(await ended.has('app-a', 'a')).toBe(false);
      expect(await ended.has('app-a', 'd')).toBe(true);
      expect(warnings).toEqual([{ event: 'ended_groups_evicting', count: 1 }]);
      await ended.remember('app-a', 'e', 99_000);
      expect(warnings).toHaveLength(1);
      advance(60_000);
      await ended.remember('app-a', 'f', 99_000);
      expect(warnings).toEqual([
        { event: 'ended_groups_evicting', count: 1 },
        { event: 'ended_groups_evicting', count: 2 },
      ]);
    });

    it('evicts plain entries first, then guarded ones whose guard has passed', async () => {
      const { ended, advance } = await harness.make(2);
      await ended.remember('app-a', 'guarded', 99_000, 5_000);
      await ended.remember('app-a', 'plain', 99_000);
      await ended.remember('app-a', 'third', 99_000);
      expect(await ended.has('app-a', 'plain')).toBe(false);
      expect(await ended.has('app-a', 'guarded')).toBe(true);
      expect(await ended.isRecoveryClosed('app-a')).toBe(false);
      advance(4_000);
      await ended.remember('app-a', 'fourth', 99_000, 50_000);
      expect(await ended.has('app-a', 'third')).toBe(false);
      await ended.remember('app-a', 'fifth', 99_000, 50_000);
      expect(await ended.has('app-a', 'guarded')).toBe(false);
      expect(await ended.has('app-a', 'fourth')).toBe(true);
      expect(await ended.isRecoveryClosed('app-a')).toBe(false);
    });

    it('a guard already passed when remembered makes a plain entry', async () => {
      const { ended } = await harness.make(1);
      await ended.remember('app-a', 'a', 99_000, 500);
      await ended.remember('app-a', 'b', 99_000);
      expect(await ended.has('app-a', 'a')).toBe(false);
      expect(await ended.isRecoveryClosed('app-a')).toBe(false);
    });

    it('with only live guarded entries, evicts one and closes recovery until its guard', async () => {
      const { ended, warnings, advance } = await harness.make(2);
      await ended.remember('app-a', 'a', 99_000, 6_000);
      await ended.remember('app-a', 'b', 99_000, 9_000);
      await ended.remember('app-a', 'c', 99_000, 9_000);
      expect(await ended.has('app-a', 'a')).toBe(false);
      expect(await ended.isRecoveryClosed('app-a')).toBe(true);
      expect(await ended.isRecoveryClosed('app-b')).toBe(false);
      expect(warnings).toContainEqual({
        event: 'ended_groups_recovery_closed',
        namespace: 'app-a',
      });
      await ended.remember('app-a', 'd', 99_000, 9_000);
      expect(
        warnings.filter((w) => (w as { event: string }).event === 'ended_groups_recovery_closed'),
      ).toHaveLength(1);
      advance(7_999);
      expect(await ended.isRecoveryClosed('app-a')).toBe(true);
      advance(1);
      expect(await ended.isRecoveryClosed('app-a')).toBe(false);
    });

    it('closes the namespace with the most guarded entries, not the one with the oldest (M5)', async () => {
      const { ended } = await harness.make(3);
      await ended.remember('honest', 'h1', 99_000, 9_000);
      await ended.remember('flood', 'f1', 99_000, 9_000);
      await ended.remember('flood', 'f2', 99_000, 9_000);
      await ended.remember('flood', 'f3', 99_000, 9_000);
      expect(await ended.isRecoveryClosed('flood')).toBe(true);
      expect(await ended.isRecoveryClosed('honest')).toBe(false);
      expect(await ended.has('honest', 'h1')).toBe(true);
      expect(await ended.has('flood', 'f1')).toBe(false);
    });
  });
}

export interface DoorHarness {
  /** A door store and a group `G1` of `app-a` it can keep state for. */
  make(): Promise<DoorStateStore>;
  cleanup?(): Promise<void>;
}

export function doorStateContract(label: string, harness: DoorHarness): void {
  const MINUTE = 60_000;
  describe(`DoorStateStore contract: ${label} (#10 AC29, R1a)`, () => {
    let doors: DoorStateStore;
    beforeEach(async () => {
      doors = await harness.make();
    });
    afterEach(async () => {
      await harness.cleanup?.();
    });

    it('rotates on the 5th failure, resets on rotation, pauses on the 3rd rotation in 30 min', async () => {
      const outcomes = [];
      for (let i = 0; i < 5; i++) outcomes.push(await doors.recordFailure('app-a', G1));
      expect(outcomes).toEqual(['counted', 'counted', 'counted', 'counted', 'rotate']);
      expect(await doors.recordRotation('app-a', G1, 0)).toEqual({ paused: false });
      expect(await doors.recordFailure('app-a', G1)).toBe('counted');
      expect(await doors.recordRotation('app-a', G1, 10 * MINUTE)).toEqual({ paused: false });
      expect(await doors.recordRotation('app-a', G1, 20 * MINUTE)).toEqual({
        paused: true,
        retryAfterMs: 10 * MINUTE,
      });
      expect(await doors.pausedFor('app-a', G1, 24 * MINUTE)).toBe(6 * MINUTE);
      expect(await doors.endPause('app-a', G1, 24 * MINUTE)).toBe(false);
      expect(await doors.endPause('app-a', G1, 30 * MINUTE)).toBe(true);
      expect(await doors.pausedFor('app-a', G1, 30 * MINUTE)).toBe(0);
    });

    it('reset lifts a pause; clear drops the state', async () => {
      for (const at of [0, 1, 2]) await doors.recordRotation('app-a', G1, at);
      expect(await doors.reset('app-a', G1, 3)).toBe(true);
      expect(await doors.pausedFor('app-a', G1, 3)).toBe(0);
      expect(await doors.reset('app-a', G1, 3)).toBe(false);
      for (let i = 0; i < 4; i++) await doors.recordFailure('app-a', G1);
      await doors.clear('app-a', G1);
      expect(await doors.recordFailure('app-a', G1)).toBe('counted');
    });
  });
}

export interface LiveGroupsHarness {
  make(): Promise<{
    store: LiveGroupsStore;
    /** The clock to pass as `budget.now` (Redis ignores it and uses TIME). */
    now: () => number;
    /** Moves time on: the memory clock, or a real wait for Redis. */
    advance: (ms: number) => Promise<void>;
    /** Live groups of `namespace` that have not passed their end bound. */
    count: (namespace: string) => Promise<number>;
  }>;
  /** True when `advance` is exact (memory); Redis waits in real time. */
  exactClock: boolean;
  cleanup?(): Promise<void>;
}

const L1 = 'C'.repeat(43);
const L2 = 'D'.repeat(43);
const L3 = 'E'.repeat(43);
const L4 = 'F'.repeat(43);
const L5 = 'H'.repeat(43);

/** Live groups and the per-app create budget (#12 3.1): memory and Redis agree. */
export function liveGroupsContract(label: string, harness: LiveGroupsHarness): void {
  describe(`LiveGroups contract: ${label} (#12 AC2, AC3, R5, R7, R13, R14)`, () => {
    let store: LiveGroupsStore;
    let now: () => number;
    let advance: (ms: number) => Promise<void>;
    let count: (namespace: string) => Promise<number>;
    beforeEach(async () => {
      ({ store, now, advance, count } = await harness.make());
    });
    afterEach(async () => {
      await harness.cleanup?.();
    });

    /** A budget at the harness clock, an hour of group life by default. */
    const budget = (over: Partial<CreateBudget> = {}): CreateBudget => ({
      now: now(),
      expiresAt: now() + 3_600_000,
      burst: 10,
      refillPerMinute: 60,
      cap: 100,
      ...over,
    });

    it('refuses at the cap without charging the budget', async () => {
      const limits = { burst: 4, cap: 3 };
      for (const id of [L1, L2, L3]) {
        expect(await store.reserve('app-a', id, budget(limits))).toEqual({ ok: true });
      }
      const full = { ok: false, reason: 'cap' };
      expect(await store.reserve('app-a', L4, budget(limits))).toEqual(full);
      expect(await store.reserve('app-a', L4, budget(limits))).toEqual(full);
      expect(await count('app-a')).toBe(3);
      // The two cap refusals left the fourth token in place.
      await store.release('app-a', L1);
      expect(await store.reserve('app-a', L4, budget(limits))).toEqual({ ok: true });
      await store.release('app-a', L2);
      expect(await store.reserve('app-a', L5, budget(limits))).toMatchObject({
        ok: false,
        reason: 'rate',
      });
    });

    it('empties the budget and refills it, with the same retryAfterMs', async () => {
      // 600 per minute: one token every 100 ms.
      const fast = { burst: 2, refillPerMinute: 600 };
      expect(await store.reserve('app-a', L1, budget(fast))).toEqual({ ok: true });
      expect(await store.reserve('app-a', L2, budget(fast))).toEqual({ ok: true });
      const refused = await store.reserve('app-a', L3, budget(fast));
      expect(refused).toMatchObject({ ok: false, reason: 'rate' });
      const wait = (refused as { retryAfterMs: number }).retryAfterMs;
      expect(Number.isSafeInteger(wait)).toBe(true);
      if (harness.exactClock) expect(wait).toBe(100);
      else expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(100);
      expect(await count('app-a')).toBe(2);
      await advance(wait + 20);
      expect(await store.reserve('app-a', L3, budget(fast))).toEqual({ ok: true });
    });

    it('rounds a fractional wait up to a whole millisecond', async () => {
      // 7 per minute: 8571.43 ms per token.
      const odd = { burst: 1, refillPerMinute: 7 };
      expect(await store.reserve('app-a', L1, budget(odd))).toEqual({ ok: true });
      const refused = (await store.reserve('app-a', L2, budget(odd))) as { retryAfterMs: number };
      expect(Number.isSafeInteger(refused.retryAfterMs)).toBe(true);
      expect(refused.retryAfterMs).toBeGreaterThanOrEqual(1);
      expect(refused.retryAfterMs).toBeLessThanOrEqual(8572);
      if (harness.exactClock) expect(refused.retryAfterMs).toBe(8572);
    });

    it('re-reserving a held group charges nothing', async () => {
      expect(await store.reserve('app-a', L1, budget({ burst: 1 }))).toEqual({ ok: true });
      expect(await store.reserve('app-a', L1, budget({ burst: 1 }))).toEqual({ ok: true });
      expect(await count('app-a')).toBe(1);
      expect(await store.reserve('app-a', L2, budget({ burst: 1 }))).toMatchObject({
        reason: 'rate',
      });
    });

    it('release frees a slot', async () => {
      expect(await store.reserve('app-a', L1, budget({ cap: 1 }))).toEqual({ ok: true });
      expect(await store.reserve('app-a', L2, budget({ cap: 1 }))).toEqual({
        ok: false,
        reason: 'cap',
      });
      await store.release('app-a', L1);
      await store.release('app-a', L1);
      expect(await count('app-a')).toBe(0);
      expect(await store.reserve('app-a', L2, budget({ cap: 1 }))).toEqual({ ok: true });
    });

    it('register ignores the budget and the cap, and charges nothing (Q-4)', async () => {
      const limits = { burst: 2, cap: 1 };
      expect(await store.reserve('app-a', L1, budget(limits))).toEqual({ ok: true });
      await store.register('app-a', L2, now() + 3_600_000);
      await store.register('app-a', L3, now() + 3_600_000);
      expect(await count('app-a')).toBe(3);
      expect(await store.reserve('app-a', L4, budget(limits))).toEqual({
        ok: false,
        reason: 'cap',
      });
      for (const id of [L1, L2, L3]) await store.release('app-a', id);
      // The second token is still there.
      expect(await store.reserve('app-a', L4, budget(limits))).toEqual({ ok: true });
    });

    it('prunes groups past their end bound', async () => {
      expect(await store.reserve('app-a', L1, budget({ cap: 1, expiresAt: now() + 50 }))).toEqual({
        ok: true,
      });
      await advance(120);
      expect(await count('app-a')).toBe(0);
      expect(await store.reserve('app-a', L2, budget({ cap: 1 }))).toEqual({ ok: true });
      expect(await count('app-a')).toBe(1);
    });

    it('keeps budgets and caps per app (AC4)', async () => {
      const one = { burst: 1, cap: 1 };
      expect(await store.reserve('app-a', L1, budget(one))).toEqual({ ok: true });
      expect(await store.reserve('app-a', L2, budget(one))).toMatchObject({ ok: false });
      expect(await store.reserve('app-b', L2, budget(one))).toEqual({ ok: true });
      expect(await count('app-a')).toBe(1);
      expect(await count('app-b')).toBe(1);
    });

    it('follows the slowest recent rate until its groups can have ended (R13, L6)', async () => {
      // A slow caller (600/min: 100 ms per token) charges first ...
      const slow = { burst: 1, refillPerMinute: 600 };
      const quick = { burst: 1, refillPerMinute: 60_000 };
      expect(await store.reserve('app-a', L1, budget(slow))).toEqual({ ok: true });
      // ... so a fast caller (1 per ms) still waits for the slow refill.
      const refused = (await store.reserve('app-a', L2, budget(quick))) as {
        retryAfterMs: number;
      };
      expect(refused).toMatchObject({ ok: false, reason: 'rate' });
      expect(refused.retryAfterMs).toBeGreaterThan(10);
      if (harness.exactClock) expect(refused.retryAfterMs).toBe(100);
      await advance(5);
      expect(await store.reserve('app-a', L2, budget(quick))).toMatchObject({ reason: 'rate' });
    });

    it('keeps the smallest recent burst, and new values apply after u (R13, L6)', async () => {
      // 600 per minute: one token every 100 ms.
      const soon = now() + 300;
      const strict = { burst: 1, refillPerMinute: 600, expiresAt: soon };
      expect(await store.reserve('app-a', L1, budget(strict))).toEqual({ ok: true });
      await advance(250);
      // 2.5 tokens refilled, but the bucket holds 1 while u holds.
      const big = { burst: 5, refillPerMinute: 600, expiresAt: soon };
      expect(await store.reserve('app-a', L2, budget(big))).toEqual({ ok: true });
      expect(await store.reserve('app-a', L3, budget(big))).toMatchObject({ reason: 'rate' });
      await advance(400);
      // u passed: the burst of 5 applies (4 tokens refilled).
      for (const id of [L3, L4, L5]) {
        expect(await store.reserve('app-a', id, budget(big))).toEqual({ ok: true });
      }
    });

    it('throws for invalid numbers before any call (R7, L2)', async () => {
      const bad: Array<Partial<CreateBudget>> = [
        ...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY].flatMap((n) => [
          { cap: n },
          { burst: n },
        ]),
        { refillPerMinute: 0 },
        { refillPerMinute: -1 },
        { refillPerMinute: Number.NaN },
        { refillPerMinute: Number.POSITIVE_INFINITY },
        { expiresAt: Number.NaN },
      ];
      for (const over of bad) {
        await expect(
          store.reserve('app-a', L1, budget(over)),
          JSON.stringify(over),
        ).rejects.toThrow(RangeError);
      }
      await expect(store.register('app-a', L1, Number.NaN)).rejects.toThrow(RangeError);
      expect(await count('app-a')).toBe(0);
    });

    it('keeps waits safe integers at a tiny rate (R14, L8, L12)', async () => {
      // cap 3, burst 1, maxSessionMinutes 10^12: (1.5 - 1) / 10^12 per minute.
      const tiny = { cap: 3, burst: 1, refillPerMinute: 0.5 / 1e12, expiresAt: now() + 6e16 };
      expect(await store.reserve('app-a', L1, budget(tiny))).toEqual({ ok: true });
      expect(await store.reserve('app-a', L2, budget(tiny))).toEqual({
        ok: false,
        reason: 'rate',
        retryAfterMs: MAX_RETRY_AFTER_MS,
      });
      // Even a denormal-sized rate stays > 0 on its way to the store.
      expect(
        await store.reserve('app-b', L1, budget({ ...tiny, refillPerMinute: 1e-300 })),
      ).toEqual({ ok: true });
    });
  });
}
