import {
  DOOR_FAILURES_BEFORE_ROTATION,
  DOOR_PAUSE_MS,
  DOOR_ROTATIONS_BEFORE_PAUSE,
  DOOR_ROTATION_WINDOW_MS,
} from '../limits/constants.js';
import type { Cancel, Scheduler } from '../time/scheduler.js';

interface DoorState {
  /** Wrong door codes against the current door code; no time decay (R1a). */
  failures: number;
  /** Times of door rotations after failures inside the rotation window. */
  rotations: number[];
  /** While set and in the future, method A joins are paused. */
  pausedUntil?: number | undefined;
  /** The pause-end timer. */
  cancel?: Cancel | undefined;
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
 * minutes. Holds no codes. Synchronous; the pause-end timer runs on the
 * injected scheduler.
 */
export class DoorGuard {
  private readonly groups = new Map<string, DoorState>();

  constructor(private readonly scheduler: Scheduler) {}

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
   * and the 3rd rotation inside the window starts a pause whose end runs
   * `onPauseEnd` (under the caller's own lock).
   */
  recordRotation(key: string, now: number, onPauseEnd: () => void): RotationResult {
    const state = this.state(key);
    state.failures = 0;
    state.rotations = state.rotations.filter((at) => at > now - DOOR_ROTATION_WINDOW_MS);
    state.rotations.push(now);
    if (state.rotations.length < DOOR_ROTATIONS_BEFORE_PAUSE) return { paused: false };
    state.cancel?.();
    state.pausedUntil = now + DOOR_PAUSE_MS;
    state.cancel = this.scheduler.at(state.pausedUntil, onPauseEnd);
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
    state.cancel = undefined;
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
    state.cancel?.();
    this.groups.delete(key);
    return wasPaused;
  }

  /** The group is gone: its state and pause timer are dropped (AC31). */
  clear(key: string): void {
    this.groups.get(key)?.cancel?.();
    this.groups.delete(key);
  }

  /** Server shutdown (AC31). */
  clearAll(): void {
    for (const state of this.groups.values()) state.cancel?.();
    this.groups.clear();
  }

  /** Number of groups with door state. For tests only. */
  get size(): number {
    return this.groups.size;
  }
}
