import { useCallback, useMemo, useState } from 'react';
import { type Clock, useCountdown } from './countdown.js';
import type { LeaderError } from './leader-errors.js';

const monotonic: Clock = () => performance.now();

/**
 * Milliseconds left of a server-given wait (#25 architecture 7.2, AC53):
 * `deadline` is a local time on `clock` (default monotonic), recomputed
 * every tick and on `visibilitychange`; 0 without one or once it passed.
 */
export function useRetryWait(deadline: number | null, clock: Clock = monotonic): number {
  return useCountdown(deadline, clock) ?? 0;
}

export interface ActionError {
  readonly error: LeaderError;
  /** The person's name (already localised) for a `{name}` template. */
  readonly name?: string;
  /** Local monotonic time the wait ends, for `RATE_LIMITED`. */
  readonly deadline: number | null;
}

export interface ActionErrorState {
  readonly current: ActionError | null;
  /** Wait left; the action's button is inactive while > 0. */
  readonly waitLeft: number;
  readonly set: (error: LeaderError | null, name?: string) => void;
  readonly clear: () => void;
}

/** One action's inline error with its rate-limit wait (design 7.11). */
export function useActionError(): ActionErrorState {
  const [current, setCurrent] = useState<ActionError | null>(null);
  const waitLeft = useRetryWait(current?.deadline ?? null);
  const set = useCallback((error: LeaderError | null, name?: string) => {
    if (error === null) {
      setCurrent(null);
      return;
    }
    setCurrent({
      error,
      ...(name !== undefined ? { name } : {}),
      deadline: error.retryAfterMs !== undefined ? performance.now() + error.retryAfterMs : null,
    });
  }, []);
  const clear = useCallback(() => setCurrent(null), []);
  return useMemo(() => ({ current, waitLeft, set, clear }), [current, waitLeft, set, clear]);
}
