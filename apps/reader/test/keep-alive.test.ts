import { describe, expect, it } from 'vitest';
import { MAX_COUNTDOWN_MS, keepAliveDeadline, keepAliveView } from '../src/group/keep-alive.js';

describe('keep-alive card state and copy (#25 architecture 8.3, design F19, D2)', () => {
  const base = { remainingMs: 30_000, handoff: 'auto' as const, othersHere: 1, lastChance: false };

  it('counts down with the pause wording', () => {
    expect(keepAliveView(base)).toEqual({
      state: 'counting',
      titleKey: 'keepAliveTitle',
      bodyKey: 'keepAliveBody',
    });
  });

  it.each([
    ['auto', 1, 'keepAlivePausedHandoff'],
    ['auto', 0, 'keepAlivePausedWait'],
    ['frozen', 3, 'keepAlivePausedWait'],
    [null, 3, 'keepAlivePausedWait'],
  ] as const)('run-out with %s and %i others here -> %s', (handoff, othersHere, bodyKey) => {
    expect(keepAliveView({ ...base, remainingMs: 0, handoff, othersHere })).toEqual({
      state: 'paused',
      titleKey: 'keepAlivePausedTitle',
      bodyKey,
    });
  });

  it('last chance: the "ends" wording and no paused state, even at 0', () => {
    for (const remainingMs of [30_000, 0]) {
      expect(keepAliveView({ ...base, remainingMs, lastChance: true })).toEqual({
        state: 'last-chance',
        titleKey: 'keepAliveTitle',
        bodyKey: 'keepAliveBodyLast',
      });
    }
  });

  it('clamps the server duration (R22, L2)', () => {
    const now = 1_000_000;
    const prompt = (countdownMs: number) => ({
      groupId: 'g',
      countdownMs,
      deadlineAt: now + countdownMs,
    });
    expect(keepAliveDeadline(prompt(60_000), now)).toBe(now + 60_000);
    expect(keepAliveDeadline(prompt(-1), now)).toBe(now);
    expect(keepAliveDeadline(prompt(1e12), now)).toBe(now + MAX_COUNTDOWN_MS);
    expect(keepAliveDeadline(prompt(Number.NaN), now)).toBe(now);
  });
});
