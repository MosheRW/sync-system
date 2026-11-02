import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_TIMER_DELAY_MS, realScheduler } from '../src/time/scheduler.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('realScheduler (R3)', () => {
  it('runs a task at its time and not before', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const scheduler = realScheduler(() => Date.now());
    const task = vi.fn();
    scheduler.at(1_000_500, task);
    vi.advanceTimersByTime(499);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledOnce();
  });

  it('runs a past-due task promptly', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const task = vi.fn();
    realScheduler(() => Date.now()).at(0, task);
    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledOnce();
  });

  it('re-arms beyond the setTimeout maximum instead of firing early (M2)', () => {
    vi.useFakeTimers({ now: 0 });
    const scheduler = realScheduler(() => Date.now());
    const task = vi.fn();
    const thirtyDays = 30 * 86_400_000;
    scheduler.at(thirtyDays, task);
    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS + 10);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(thirtyDays - MAX_TIMER_DELAY_MS - 11);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledOnce();
  });

  it('cancels, also after a re-arm', () => {
    vi.useFakeTimers({ now: 0 });
    const scheduler = realScheduler(() => Date.now());
    const near = vi.fn();
    const far = vi.fn();
    scheduler.at(100, near)();
    const cancelFar = scheduler.at(30 * 86_400_000, far);
    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS + 1);
    cancelFar();
    vi.advanceTimersByTime(30 * 86_400_000);
    expect(near).not.toHaveBeenCalled();
    expect(far).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unrefs its timers', () => {
    const scheduler = realScheduler();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const cancel = scheduler.at(Date.now() + 60_000, () => undefined);
    const handle = spy.mock.results[0]!.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    cancel();
    spy.mockRestore();
  });
});

describe('ManualScheduler', () => {
  it('runs due tasks in time order with the clock at each task time', () => {
    const scheduler = new ManualScheduler(0);
    const seen: Array<[string, number]> = [];
    scheduler.at(30, () => seen.push(['c', scheduler.now()]));
    scheduler.at(10, () => seen.push(['a', scheduler.now()]));
    scheduler.at(10, () => seen.push(['b', scheduler.now()]));
    const cancel = scheduler.at(20, () => seen.push(['x', scheduler.now()]));
    cancel();
    scheduler.advance(25);
    expect(seen).toEqual([
      ['a', 10],
      ['b', 10],
    ]);
    expect(scheduler.now()).toBe(25);
    expect(scheduler.pending).toBe(1);
    scheduler.advance(5);
    expect(seen.at(-1)).toEqual(['c', 30]);
  });

  it('runs tasks scheduled by tasks when they are due', () => {
    const scheduler = new ManualScheduler(0);
    const seen: number[] = [];
    scheduler.at(10, () => scheduler.at(15, () => seen.push(scheduler.now())));
    scheduler.advance(20);
    expect(seen).toEqual([15]);
  });
});
