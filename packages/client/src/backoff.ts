export interface BackoffPolicy {
  /** Cap of the first delay in ms. */
  initialDelayMs: number;
  /** Largest cap in ms. */
  maxDelayMs: number;
}

/**
 * "Server busy" signals the client can tell apart (M3): close 1001 (going
 * away), 4003 (app connection limit) and 4008 (too many messages). A 503 on
 * upgrade looks like a network error in browsers and stays on the normal
 * sequence.
 */
export type BusySignal = 'going_away' | 'app_connection_limit' | 'too_many_messages';

/** A busy signal raises the streak to at least this, so the first wait has a 2 s cap (M3). */
export const BUSY_STREAK_FLOOR = 3;

/** Largest cap after APP_CONNECTION_LIMIT (Q-E). */
export const APP_CONNECTION_LIMIT_MAX_DELAY_MS = 30_000;

/** Cap for failure number `streak` (1-based): `min(maxDelayMs, initialDelayMs * 2^(streak-1))`. */
export function delayCap(streak: number, policy: BackoffPolicy, signal?: BusySignal): number {
  const exponent = Math.max(0, streak - 1);
  const max =
    signal === 'app_connection_limit'
      ? Math.max(policy.maxDelayMs, APP_CONNECTION_LIMIT_MAX_DELAY_MS)
      : policy.maxDelayMs;
  return Math.min(max, policy.initialDelayMs * 2 ** exponent);
}

/** A random value forced into `[0, 1]`, so a bad random source cannot break the delay. */
function unit(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 1);
}

/**
 * Exponential backoff with full jitter (Q3, AC26):
 * `floor(random() * min(maxDelayMs, initialDelayMs * 2^(streak-1)))`.
 * After APP_CONNECTION_LIMIT the largest cap is 30 s (Q-E).
 */
export function nextDelay(
  streak: number,
  policy: BackoffPolicy,
  random: () => number,
  signal?: BusySignal,
): number {
  return Math.floor(unit(random) * delayCap(streak, policy, signal));
}

/**
 * The streak after a failed attempt or a drop: one more, and at least
 * BUSY_STREAK_FLOOR for a busy signal (M3). Timeout-caused drops and fatal
 * failures count too; nothing here ever lowers the streak.
 */
export function streakAfterFailure(streak: number, signal?: BusySignal): number {
  const next = streak + 1;
  return signal === undefined ? next : Math.max(next, BUSY_STREAK_FLOOR);
}

/**
 * Stability rule (H1): when a connection that reached `connected` drops, the
 * streak resets only if it stayed up for at least `stableAfterMs`. A drop
 * sooner than that continues the sequence, so a server that completes the
 * handshake and then drops every socket gets growing delays.
 */
export function streakAfterDrop(
  streak: number,
  connectedForMs: number,
  stableAfterMs: number,
): number {
  return connectedForMs >= stableAfterMs ? 0 : streak;
}
