/**
 * Lazy, typed access to the host timer and clock (pattern of
 * `@mosherw/sync-system-client`'s host module). Nothing here runs at import time
 * (AC12): every global is looked up on each call, so the package can be
 * imported during SSR and fake timers in tests work. This is the only module
 * of the package that reads `globalThis`.
 */

interface HostGlobals {
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  queueMicrotask?: (callback: () => void) => void;
}

function host(): HostGlobals {
  return globalThis as unknown as HostGlobals;
}

/** Largest delay `setTimeout` honours; larger values fire after about 1 ms (R9). */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** Clamps a delay to `[0, 2^31-1]`; `NaN` and non-finite negatives become 0 (R9). */
export function clampDelay(ms: number): number {
  if (Number.isNaN(ms) || ms < 0) return 0;
  return Math.min(ms, MAX_TIMER_MS);
}

declare const timerBrand: unique symbol;
/** Opaque handle of a timer started with `setTimer`. */
export type TimerHandle = { readonly [timerBrand]: true };

/** The only way the package starts a timer: the delay is always clamped. */
export function setTimer(callback: () => void, ms: number): TimerHandle {
  const start = host().setTimeout;
  if (typeof start !== 'function') throw new TypeError('setTimeout is not available');
  return start(callback, clampDelay(ms)) as TimerHandle;
}

export function clearTimer(handle: TimerHandle | undefined): void {
  if (handle === undefined) return;
  const clear = host().clearTimeout;
  if (typeof clear === 'function') clear(handle);
}

/** Runs `callback` after the current synchronous work (falls back to a resolved promise). */
export function microtask(callback: () => void): void {
  const queue = host().queueMicrotask;
  if (typeof queue === 'function') queue(callback);
  else void Promise.resolve().then(callback);
}

/** Current time in ms, read on each call (fake timers mock `Date`). */
export function now(): number {
  return Date.now();
}
