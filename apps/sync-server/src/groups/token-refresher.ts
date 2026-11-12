import type { Cancel, Scheduler } from '../time/scheduler.js';

export interface RefreshPolicy {
  /** N: activities that allow a refresh once the min interval passed. */
  activities: number;
  /** Min interval between refreshes, ms. */
  minMs: number;
  /** Max interval: one activity is enough once it passed (timer-driven), ms. */
  maxMs: number;
}

interface State {
  activities: number;
  lastTokenAt: number;
  cancel: Cancel | undefined;
  refresh: (at: number) => void;
}

/**
 * When to send the leader a refreshed token (#5 AC12, architecture 6.4).
 * A refresh happens when either
 * (a) at least N activities happened since the last token and at least the
 *     min interval passed, or
 * (b) at least one activity happened and the max interval passed. This is
 *     timer-driven, so it does not wait for the next activity.
 * Without activity there is no refresh. State exists only while the leader
 * is online (\`reset\` on create, return and recreation; \`clear\` when it goes
 * offline or the group ends or is dropped). Member tokens are never
 * refreshed (AC13).
 */
export class TokenRefresher {
  private readonly states = new Map<string, State>();

  constructor(
    private readonly scheduler: Scheduler,
    private readonly policy: RefreshPolicy,
  ) {}

  /** Groups with refresh state. For tests only. */
  get size(): number {
    return this.states.size;
  }

  /**
   * A fresh token was just issued at \`at\`: counting starts again. \`refresh\`
   * is called when the policy says a new token is due.
   */
  reset(key: string, at: number, refresh: (at: number) => void): void {
    this.states.get(key)?.cancel?.();
    this.states.set(key, { activities: 0, lastTokenAt: at, cancel: undefined, refresh });
  }

  /** A leader activity at \`at\` (accepted position update). */
  activity(key: string, at: number): void {
    const state = this.states.get(key);
    if (state === undefined) return;
    state.activities += 1;
    const elapsed = at - state.lastTokenAt;
    const { activities, minMs, maxMs } = this.policy;
    if ((state.activities >= activities && elapsed >= minMs) || elapsed >= maxMs) {
      this.refresh(key, state, at);
      return;
    }
    const dueAt =
      state.activities >= activities ? state.lastTokenAt + minMs : state.lastTokenAt + maxMs;
    state.cancel?.();
    state.cancel = this.scheduler.at(dueAt, () => {
      const current = this.states.get(key);
      if (current !== state) return;
      state.cancel = undefined;
      if (state.activities >= 1) this.refresh(key, state, this.scheduler.now());
    });
  }

  /** Whether the group has refresh state (its leader is online here). */
  has(key: string): boolean {
    return this.states.has(key);
  }

  clear(key: string): void {
    this.states.get(key)?.cancel?.();
    this.states.delete(key);
  }

  clearAll(): void {
    for (const key of [...this.states.keys()]) this.clear(key);
  }

  private refresh(key: string, state: State, at: number): void {
    this.reset(key, at, state.refresh);
    state.refresh(at);
  }
}
