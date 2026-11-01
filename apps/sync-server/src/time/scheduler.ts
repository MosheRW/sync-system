/** Cancels a scheduled task. Idempotent. */
export type Cancel = () => void;

/**
 * Clock plus one-shot timers, injected so group timers can be tested with a
 * manual clock instead of fake timers (which would interfere with socket
 * I/O). Tasks must not throw: callers wrap their own work.
 */
export interface Scheduler {
  /** Epoch ms. */
  now(): number;
  /** Runs `task` once at or after `timeMs` (epoch ms). */
  at(timeMs: number, task: () => void): Cancel;
}

/** Largest delay `setTimeout` honours; longer delays fire after about 1 ms. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Real timers, `unref()`ed so they never keep the process alive. A target
 * beyond the setTimeout maximum (about 24.8 days) is reached by re-arming at
 * the maximum, never by firing early (M2, R3).
 */
export function realScheduler(now: () => number = Date.now): Scheduler {
  return {
    now,
    at(timeMs, task) {
      let handle: NodeJS.Timeout | undefined;
      let cancelled = false;
      const arm = () => {
        const delay = timeMs - now();
        if (delay > MAX_TIMER_DELAY_MS) {
          handle = setTimeout(arm, MAX_TIMER_DELAY_MS);
        } else {
          handle = setTimeout(
            () => {
              if (!cancelled) task();
            },
            Math.max(0, delay),
          );
        }
        handle.unref();
      };
      arm();
      return () => {
        cancelled = true;
        clearTimeout(handle);
      };
    },
  };
}
