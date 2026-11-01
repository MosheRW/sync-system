import { describe, expect, it, vi } from 'vitest';
import { GroupTimers } from '../src/groups/group-timers.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';

describe('GroupTimers (architecture 6.3)', () => {
  it('runs each kind once at its time and forgets it', () => {
    const scheduler = new ManualScheduler(0);
    const timers = new GroupTimers(scheduler);
    const maxSession = vi.fn();
    const frozen = vi.fn();
    timers.armMaxSession('g', 100, maxSession);
    timers.armFrozenEnd('g', 50, frozen);
    expect(timers.size).toBe(1);
    scheduler.advance(50);
    expect(frozen).toHaveBeenCalledOnce();
    expect(maxSession).not.toHaveBeenCalled();
    scheduler.advance(50);
    expect(maxSession).toHaveBeenCalledOnce();
    expect(timers.size).toBe(0);
  });

  it('replaces a timer of the same kind', () => {
    const scheduler = new ManualScheduler(0);
    const timers = new GroupTimers(scheduler);
    const first = vi.fn();
    const second = vi.fn();
    timers.armFrozenEnd('g', 10, first);
    timers.armFrozenEnd('g', 20, second);
    scheduler.advance(30);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it('clears one kind, one group or everything', () => {
    const scheduler = new ManualScheduler(0);
    const timers = new GroupTimers(scheduler);
    const task = vi.fn();
    timers.armMaxSession('a', 10, task);
    timers.armFrozenEnd('a', 10, task);
    timers.armMaxSession('b', 10, task);
    timers.armMaxSession('c', 10, task);
    timers.clearFrozenEnd('a');
    expect(scheduler.pending).toBe(3);
    timers.clear('b');
    expect(scheduler.pending).toBe(2);
    timers.clearAll();
    expect(scheduler.pending).toBe(0);
    expect(timers.size).toBe(0);
    scheduler.advance(100);
    expect(task).not.toHaveBeenCalled();
  });
});
