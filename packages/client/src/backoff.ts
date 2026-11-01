export interface BackoffPolicy {
  /** Cap of the first delay in ms. */
  initialDelayMs: number;
  /** Largest cap in ms. */
  maxDelayMs: number;
}

/** Cap for failure number `streak` (1-based): `min(maxDelayMs, initialDelayMs * 2^(streak-1))`. */
export function delayCap(streak: number, policy: BackoffPolicy): number {
  const exponent = Math.max(0, streak - 1);
  return Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** exponent);
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
 */
export function nextDelay(streak: number, policy: BackoffPolicy, random: () => number): number {
  return Math.floor(unit(random) * delayCap(streak, policy));
}
