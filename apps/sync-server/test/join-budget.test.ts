import { describe, expect, it } from 'vitest';
import {
  MAX_JOIN_BUDGET_LIMIT,
  MAX_JOIN_BUDGET_WINDOW_MS,
  MemoryJoinBudget,
  checkJoinBudget,
} from '../src/joins/join-budget.js';
import { SlidingWindowRateLimiter } from '../src/limits/rate-limiter.js';
import { TestClock } from './helpers/test-server.js';

/**
 * The in-memory per-app join budget (#41): the one-instance path keeps
 * today's limiter, result for result.
 */
describe('MemoryJoinBudget (#41 AC6)', () => {
  it('gives the same results as SlidingWindowRateLimiter for one sequence', async () => {
    const clock = new TestClock();
    const budget = new MemoryJoinBudget(clock.now, 1000);
    const limiter = new SlidingWindowRateLimiter(clock.now, 1000);
    // Steps in ms between attempts: fill, refuse, slide, refuse, the boundary.
    const steps = [0, 100, 100, 100, 300, 400, 99, 1, 1, 500, 1000, 0, 0, 0];
    for (const step of steps) {
      clock.advance(step);
      expect(await budget.tryAcquire('app-a', 3)).toEqual(limiter.tryAcquire('app-a', 3));
    }
  });

  it('accepts to the limit, refuses with retryAfterMs, and records no refusal', async () => {
    const clock = new TestClock();
    const budget = new MemoryJoinBudget(clock.now, 60_000);
    for (let i = 0; i < 3; i++) expect(await budget.tryAcquire('app-a', 3)).toEqual({ ok: true });
    expect(await budget.tryAcquire('app-a', 3)).toEqual({ ok: false, retryAfterMs: 60_000 });
    clock.advance(59_999);
    expect(await budget.tryAcquire('app-a', 3)).toEqual({ ok: false, retryAfterMs: 1 });
    clock.advance(1);
    // The refusals were not recorded: all three slots are free again.
    for (let i = 0; i < 3; i++) expect(await budget.tryAcquire('app-a', 3)).toEqual({ ok: true });
    // Another app has its own budget.
    expect(await budget.tryAcquire('app-b', 3)).toEqual({ ok: true });
    expect(budget.size).toBe(2);
    budget.clear();
    expect(budget.size).toBe(0);
    expect(await budget.tryAcquire('app-a', 3)).toEqual({ ok: true });
  });

  it('rejects a limit or window outside the caps (#41 security S6)', async () => {
    const clock = new TestClock();
    for (const limit of [0, -1, 1.5, Number.NaN, MAX_JOIN_BUDGET_LIMIT + 1]) {
      await expect(new MemoryJoinBudget(clock.now).tryAcquire('app-a', limit)).rejects.toThrow(
        RangeError,
      );
    }
    for (const windowMs of [0, 0.5, MAX_JOIN_BUDGET_WINDOW_MS + 1]) {
      await expect(
        new MemoryJoinBudget(clock.now, windowMs).tryAcquire('app-a', 1),
      ).rejects.toThrow(RangeError);
    }
    expect(() => checkJoinBudget(MAX_JOIN_BUDGET_LIMIT, MAX_JOIN_BUDGET_WINDOW_MS)).not.toThrow();
  });
});
