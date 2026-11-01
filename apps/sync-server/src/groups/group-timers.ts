import type { Cancel, Scheduler } from '../time/scheduler.js';

type TimerKind = 'frozenEnd';

/**
 * Per-group timers (architecture 6.3). Each group has at most one timer of
 * each kind; arming a kind again replaces the previous one. Callbacks must
 * take the group lock and re-read the group: a timer may be stale.
 */
export class GroupTimers {
  private readonly timers = new Map<string, Partial<Record<TimerKind, Cancel>>>();

  constructor(private readonly scheduler: Scheduler) {}

  /** Number of groups with at least one timer. For tests only. */
  get size(): number {
    return this.timers.size;
  }

  /** Frozen-group end (leader offline): armed on leader disconnect. */
  armFrozenEnd(key: string, at: number, task: () => void): void {
    this.arm(key, 'frozenEnd', at, task);
  }

  clearFrozenEnd(key: string): void {
    this.cancel(key, 'frozenEnd');
  }

  /** Cancels every timer of the group (end, drop). */
  clear(key: string): void {
    const entry = this.timers.get(key);
    if (entry === undefined) return;
    for (const cancel of Object.values(entry)) cancel();
    this.timers.delete(key);
  }

  /** Cancels every timer (server shutdown). */
  clearAll(): void {
    for (const key of [...this.timers.keys()]) this.clear(key);
  }

  private arm(key: string, kind: TimerKind, at: number, task: () => void): void {
    this.cancel(key, kind);
    const entry = this.timers.get(key) ?? {};
    entry[kind] = this.scheduler.at(at, () => {
      this.forget(key, kind);
      task();
    });
    this.timers.set(key, entry);
  }

  private cancel(key: string, kind: TimerKind): void {
    const entry = this.timers.get(key);
    const cancel = entry?.[kind];
    if (cancel === undefined) return;
    cancel();
    this.forget(key, kind);
  }

  private forget(key: string, kind: TimerKind): void {
    const entry = this.timers.get(key);
    if (entry === undefined) return;
    delete entry[kind];
    if (Object.keys(entry).length === 0) this.timers.delete(key);
  }
}
