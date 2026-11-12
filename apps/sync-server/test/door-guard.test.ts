import { describe, expect, it } from 'vitest';
import { DoorGuard } from '../src/joins/door-guard.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';

const MINUTE = 60_000;
const KEY = 'app-a:G';

function failTimes(guard: DoorGuard, n: number): string[] {
  return Array.from({ length: n }, () => guard.recordFailure(KEY));
}

describe('DoorGuard (#10 AC29, R1a)', () => {
  it('asks for a rotation on the 5th failure since the last door-code change', () => {
    const guard = new DoorGuard();
    expect(failTimes(guard, 5)).toEqual(['counted', 'counted', 'counted', 'counted', 'rotate']);
  });

  it('never decays failures over time: 4 failures, hours later 1 more, rotates', () => {
    const scheduler = new ManualScheduler();
    const guard = new DoorGuard();
    failTimes(guard, 4);
    scheduler.advance(11 * MINUTE);
    expect(guard.recordFailure(KEY)).toBe('rotate');
    guard.recordRotation(KEY, scheduler.now());
    failTimes(guard, 4);
    scheduler.advance(5 * 60 * MINUTE);
    expect(guard.recordFailure(KEY)).toBe('rotate');
  });

  it('resets the counter on each rotation', () => {
    const scheduler = new ManualScheduler();
    const guard = new DoorGuard();
    failTimes(guard, 5);
    guard.recordRotation(KEY, scheduler.now());
    expect(guard.failuresOf(KEY)).toBe(0);
    expect(failTimes(guard, 4)).not.toContain('rotate');
  });

  it('pauses for 10 minutes on the 3rd rotation within 30 minutes, then ends the pause', () => {
    const scheduler = new ManualScheduler();
    const guard = new DoorGuard();
    expect(guard.recordRotation(KEY, scheduler.now())).toEqual({ paused: false });
    scheduler.advance(10 * MINUTE);
    expect(guard.recordRotation(KEY, scheduler.now())).toEqual({ paused: false });
    scheduler.advance(10 * MINUTE);
    expect(guard.recordRotation(KEY, scheduler.now())).toEqual({
      paused: true,
      retryAfterMs: 10 * MINUTE,
    });
    expect(guard.pausedFor(KEY, scheduler.now())).toBe(10 * MINUTE);
    scheduler.advance(4 * MINUTE);
    expect(guard.pausedFor(KEY, scheduler.now())).toBe(6 * MINUTE);
    expect(guard.endPause(KEY, scheduler.now())).toBe(false);
    scheduler.advance(6 * MINUTE);
    expect(guard.pausedFor(KEY, scheduler.now())).toBe(0);
    expect(guard.endPause(KEY, scheduler.now())).toBe(true);
    expect(guard.endPause(KEY, scheduler.now())).toBe(false);
    // The earlier rotations are still in the window: the next one pauses at once.
    expect(guard.recordRotation(KEY, scheduler.now()).paused).toBe(true);
  });

  it('does not pause when rotations are spread over more than 30 minutes', () => {
    const scheduler = new ManualScheduler();
    const guard = new DoorGuard();
    for (let i = 0; i < 5; i++) {
      expect(guard.recordRotation(KEY, scheduler.now()).paused).toBe(false);
      scheduler.advance(16 * MINUTE);
    }
  });

  it('reset lifts a pause and clears the history; clear and clearAll drop state', () => {
    const scheduler = new ManualScheduler();
    const guard = new DoorGuard();
    for (let i = 0; i < 3; i++) guard.recordRotation(KEY, scheduler.now());
    expect(guard.pausedFor(KEY, scheduler.now())).toBe(10 * MINUTE);
    expect(guard.reset(KEY, scheduler.now())).toBe(true);
    expect(guard.pausedFor(KEY, scheduler.now())).toBe(0);
    expect(guard.reset(KEY, scheduler.now())).toBe(false);
    expect(guard.recordRotation(KEY, scheduler.now()).paused).toBe(false);

    guard.recordRotation('app-a:H', scheduler.now());
    expect(guard.size).toBe(2);
    guard.clear(KEY);
    expect(guard.size).toBe(1);
    expect(guard.failuresOf(KEY)).toBe(0);
    guard.clearAll();
    expect(guard.size).toBe(0);
  });

  it('never arms a timer itself: the caller arms the pause end (#35 ADR 0013)', () => {
    const scheduler = new ManualScheduler();
    const guard = new DoorGuard();
    for (let i = 0; i < 3; i++) guard.recordRotation(KEY, scheduler.now());
    expect(scheduler.pending).toBe(0);
  });
});
