import type { Cancel, Scheduler } from '../time/scheduler.js';

/**
 * Timer kinds (#13 D7, #35 ADR 0013): max session, the frozen bound, the
 * keep-alive prompt and its deadline, the grace end of a pause, the end of
 * a door-code pause, and (Redis, #35 architecture 12.9) the earliest
 * deadline of a pending method B request.
 */
export const TIMER_KINDS = [
  'maxSession',
  'frozenEnd',
  'keepAlivePrompt',
  'keepAliveDeadline',
  'grace',
  'doorPauseEnd',
  'approvalDue',
] as const;
export type TimerKind = (typeof TIMER_KINDS)[number];

/** Plain data a timer carries (stored as is in Redis): the grace's term and deadline. */
export interface TimerData {
  readonly term: number;
  readonly at: number;
}

/**
 * Runs a due timer. Handlers take the group lock and re-read the group: a
 * timer may be stale. `claim`, when given, must run inside the handler's
 * locked task: it marks the stored timer done in that task's commit.
 */
export type TimerHandler = (
  namespace: string,
  groupId: string,
  data: TimerData | undefined,
  claim?: () => void,
) => void;

/** How a backend fires a due timer. */
export type TimerFire = (
  namespace: string,
  groupId: string,
  kind: TimerKind,
  data: TimerData | undefined,
  claim?: () => void,
) => void;

/** Where timers live: `setTimeout` in memory, a due set in Redis (#35 ADR 0013). */
export interface TimerBackend {
  /** Starts calling `fire` for due timers. */
  start(fire: TimerFire): void;
  arm(namespace: string, groupId: string, kind: TimerKind, at: number, data?: TimerData): void;
  clear(namespace: string, groupId: string, kind: TimerKind): void;
  clearGroup(namespace: string, groupId: string): void;
  /** Stops every local timer (shutdown). Stored timers stay stored. */
  stop(): void;
  /** Groups with a local timer. For tests only. */
  readonly size: number;
}

interface MemoryEntry {
  namespace: string;
  groupId: string;
  timers: Partial<Record<TimerKind, Cancel>>;
}

function keyOf(namespace: string, groupId: string): string {
  return `${namespace}:${groupId}`;
}

/**
 * One `setTimeout` per armed timer (architecture 6.3). Each group has at
 * most one timer of each kind; arming a kind again replaces it. A restart
 * loses every timer, like the groups themselves.
 */
export class MemoryTimerBackend implements TimerBackend {
  private readonly groups = new Map<string, MemoryEntry>();
  private fire: TimerFire = () => undefined;

  constructor(private readonly scheduler: Scheduler) {}

  get size(): number {
    return this.groups.size;
  }

  start(fire: TimerFire): void {
    this.fire = fire;
  }

  arm(namespace: string, groupId: string, kind: TimerKind, at: number, data?: TimerData): void {
    this.clear(namespace, groupId, kind);
    const key = keyOf(namespace, groupId);
    let entry = this.groups.get(key);
    if (entry === undefined) {
      entry = { namespace, groupId, timers: {} };
      this.groups.set(key, entry);
    }
    entry.timers[kind] = this.scheduler.at(at, () => {
      this.forget(key, kind);
      this.fire(namespace, groupId, kind, data);
    });
  }

  clear(namespace: string, groupId: string, kind: TimerKind): void {
    const key = keyOf(namespace, groupId);
    const cancel = this.groups.get(key)?.timers[kind];
    if (cancel === undefined) return;
    cancel();
    this.forget(key, kind);
  }

  clearGroup(namespace: string, groupId: string): void {
    const key = keyOf(namespace, groupId);
    const entry = this.groups.get(key);
    if (entry === undefined) return;
    for (const cancel of Object.values(entry.timers)) cancel();
    this.groups.delete(key);
  }

  stop(): void {
    for (const entry of [...this.groups.values()]) this.clearGroup(entry.namespace, entry.groupId);
  }

  /** Whether a timer of `kind` is armed. For tests only. */
  has(namespace: string, groupId: string, kind: TimerKind): boolean {
    return this.groups.get(keyOf(namespace, groupId))?.timers[kind] !== undefined;
  }

  private forget(key: string, kind: TimerKind): void {
    const entry = this.groups.get(key);
    if (entry === undefined) return;
    delete entry.timers[kind];
    if (Object.keys(entry.timers).length === 0) this.groups.delete(key);
  }
}

/**
 * Per-group timers dispatched by kind (#35 ADR 0013): a handler per kind is
 * registered once, and a timer carries plain data only, so a stored timer
 * can fire in another process after a restart. Each group has at most one
 * timer of each kind; arming a kind again replaces it.
 */
export class GroupTimers {
  private readonly handlers = new Map<TimerKind, TimerHandler>();

  constructor(private readonly backend: TimerBackend) {
    backend.start((namespace, groupId, kind, data, claim) => {
      const handler = this.handlers.get(kind);
      if (handler !== undefined) handler(namespace, groupId, data, claim);
      else this.orphan?.(namespace, groupId, claim);
    });
  }

  /** Number of groups with a local timer. For tests only. */
  get size(): number {
    return this.backend.size;
  }

  /** Called for a due timer of a kind without a handler (it is only marked done). */
  orphan: ((namespace: string, groupId: string, claim?: () => void) => void) | undefined;

  /** Registers the handler of `kind` (once, at construction of the services). */
  on(kind: TimerKind, handler: TimerHandler): void {
    this.handlers.set(kind, handler);
  }

  /** Arms one timer of `kind` at `at` (epoch ms), replacing the previous one of that kind. */
  arm(namespace: string, groupId: string, kind: TimerKind, at: number, data?: TimerData): void {
    this.backend.arm(namespace, groupId, kind, at, data);
  }

  /** Cancels the timer of `kind` only. */
  clear(namespace: string, groupId: string, kind: TimerKind): void {
    this.backend.clear(namespace, groupId, kind);
  }

  /** Cancels every timer of the group (end, drop). */
  clearGroup(namespace: string, groupId: string): void {
    this.backend.clearGroup(namespace, groupId);
  }

  /** Stops every local timer (server shutdown). */
  clearAll(): void {
    this.backend.stop();
  }
}
