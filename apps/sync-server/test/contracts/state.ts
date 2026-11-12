import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EndedGroupsStore } from '../../src/groups/ended-groups.js';
import type { CodeIndexStore } from '../../src/joins/code-index.js';
import type { DoorStateStore } from '../../src/joins/door-guard.js';

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
