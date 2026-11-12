import {
  DOOR_FAILURES_BEFORE_ROTATION,
  DOOR_PAUSE_MS,
  DOOR_ROTATIONS_BEFORE_PAUSE,
  DOOR_ROTATION_WINDOW_MS,
} from '../limits/constants.js';
/** The door state of one group, stored with the group in Redis (#35 AC7). */
export interface DoorState {
  /** Wrong door codes against the current door code; no time decay (R1a). */
  failures: number;
  /** Times of door rotations after failures inside the rotation window. */
  rotations: number[];
  /** While set and in the future, method A joins are paused. */
  pausedUntil?: number | undefined;
}

/**
 * Door-code brute-force state per method A group (#10 AC29, R1a), async so
 * the Redis store can keep it with the group (#35). The pause end is a
 * `doorPauseEnd` group timer armed by the caller.
 */
export interface DoorStateStore {
  recordFailure(namespace: string, groupId: string): Promise<'counted' | 'rotate'>;
  recordRotation(namespace: string, groupId: string, now: number): Promise<RotationResult>;
  pausedFor(namespace: string, groupId: string, now: number): Promise<number>;
  endPause(namespace: string, groupId: string, now: number): Promise<boolean>;
  reset(namespace: string, groupId: string, now: number): Promise<boolean>;
  clear(namespace: string, groupId: string): Promise<void>;
  /** Forgets local state (server shutdown). */
  clearAll(): void;
}

export interface RotationResult {
  paused: boolean;
  /** Pause length from now, when `paused`. */
  retryAfterMs?: number;
}

/**
 * Door-code brute-force state per method A group (#10 AC29, R1a). Wrong door
 * codes are counted against the current door code, with no time decay:
 * every DOOR_FAILURES_BEFORE_ROTATION-th failure since the last door-code
 * change asks for a rotation, so there is no silent guessing below the
 * threshold. The 3rd rotation inside 30 minutes pauses method A for 10
 * minutes. Holds no codes and no timer: the caller arms the pause end.
 * Synchronous; keyed by `namespace:groupId`.
 */
export class DoorGuard {
  private readonly groups = new Map<string, DoorState>();

  private state(key: string): DoorState {
    let state = this.groups.get(key);
    if (state === undefined) {
      state = { failures: 0, rotations: [] };
      this.groups.set(key, state);
    }
    return state;
  }

  /** Counts one wrong door code; `'rotate'` when the door code must change now. */
  recordFailure(key: string): 'counted' | 'rotate' {
    const state = this.state(key);
    state.failures += 1;
    return state.failures >= DOOR_FAILURES_BEFORE_ROTATION ? 'rotate' : 'counted';
  }

  /** Wrong door codes since the last door-code change. For tests only. */
  failuresOf(key: string): number {
    return this.groups.get(key)?.failures ?? 0;
  }

  /**
   * The door code was rotated after failures at `now`: the counter resets,
   * and the 3rd rotation inside the window starts a pause (until
   * `now + DOOR_PAUSE_MS`; the caller arms its end).
   */
  recordRotation(key: string, now: number): RotationResult {
    const state = this.state(key);
    state.failures = 0;
    state.rotations = state.rotations.filter((at) => at > now - DOOR_ROTATION_WINDOW_MS);
    state.rotations.push(now);
    if (state.rotations.length < DOOR_ROTATIONS_BEFORE_PAUSE) return { paused: false };
    state.pausedUntil = now + DOOR_PAUSE_MS;
    return { paused: true, retryAfterMs: DOOR_PAUSE_MS };
  }

  /** Remaining pause in ms at `now`, or 0 when method A is not paused. */
  pausedFor(key: string, now: number): number {
    const until = this.groups.get(key)?.pausedUntil;
    return until === undefined || until <= now ? 0 : until - now;
  }

  /**
   * Ends a pause whose time has come. Returns whether a pause ended (so the
   * leader is told `join.resumed` once).
   */
  endPause(key: string, now: number): boolean {
    const state = this.groups.get(key);
    if (state?.pausedUntil === undefined || state.pausedUntil > now) return false;
    state.pausedUntil = undefined;
    return true;
  }

  /**
   * The leader rotated every code (#10 AC30): counter, rotation history and
   * any pause are cleared. Returns whether a pause was lifted.
   */
  reset(key: string, now: number): boolean {
    const state = this.groups.get(key);
    if (state === undefined) return false;
    const wasPaused = state.pausedUntil !== undefined && state.pausedUntil > now;
    this.groups.delete(key);
    return wasPaused;
  }

  /** The group is gone: its state is dropped (AC31). */
  clear(key: string): void {
    this.groups.delete(key);
  }

  /** Server shutdown (AC31). */
  clearAll(): void {
    this.groups.clear();
  }

  /** A copy of the group's state, or undefined (the Redis store keeps it in the document). */
  exportState(key: string): DoorState | undefined {
    const state = this.groups.get(key);
    if (state === undefined) return undefined;
    return {
      failures: state.failures,
      rotations: [...state.rotations],
      ...(state.pausedUntil === undefined ? {} : { pausedUntil: state.pausedUntil }),
    };
  }

  /** Replaces the group's state with a copy of `state`. */
  importState(key: string, state: DoorState | undefined): void {
    if (state === undefined) {
      this.groups.delete(key);
      return;
    }
    this.groups.set(key, {
      failures: state.failures,
      rotations: [...state.rotations],
      pausedUntil: state.pausedUntil,
    });
  }

  /** Number of groups with door state. For tests only. */
  get size(): number {
    return this.groups.size;
  }
}
