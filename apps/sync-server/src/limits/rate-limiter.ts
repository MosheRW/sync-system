import { LEADER_RATE_WINDOW_MS } from './constants.js';

export type RateResult = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * Sliding-window limiter: at most `limit` accepted events per key in any
 * window of `windowMs`. Only accepted events are recorded, so rejected
 * attempts never use budget. The clock is injected for tests.
 */
export class SlidingWindowRateLimiter {
  private readonly events = new Map<string, number[]>();

  constructor(
    private readonly now: () => number,
    private readonly windowMs: number = LEADER_RATE_WINDOW_MS,
  ) {}

  tryAcquire(key: string, limit: number): RateResult {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.events.get(key) ?? []).filter((time) => time > cutoff);
    if (recent.length >= limit) {
      this.events.set(key, recent);
      return { ok: false, retryAfterMs: Math.max(1, recent[0]! + this.windowMs - now) };
    }
    recent.push(now);
    this.events.set(key, recent);
    return { ok: true };
  }

  /**
   * Whether one more event for `key` would be within `limit`, without
   * recording anything (#10 R1b). Used with `record` for budgets that are
   * checked before an action and only charged when it fails.
   */
  check(key: string, limit: number): RateResult {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.events.get(key) ?? []).filter((time) => time > cutoff);
    if (recent.length === 0) {
      this.events.delete(key);
      return { ok: true };
    }
    this.events.set(key, recent);
    if (recent.length >= limit) {
      return { ok: false, retryAfterMs: Math.max(1, recent[0]! + this.windowMs - now) };
    }
    return { ok: true };
  }

  /** Records one event for `key` now, whatever the limit (#10 R1b). */
  record(key: string): void {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const recent = (this.events.get(key) ?? []).filter((time) => time > cutoff);
    recent.push(now);
    this.events.set(key, recent);
  }

  forget(key: string): void {
    this.events.delete(key);
  }

  /** Forgets every key (server shutdown). The limiter holds no timers. */
  clear(): void {
    this.events.clear();
  }

  /** Number of tracked keys. For tests only. */
  get size(): number {
    return this.events.size;
  }
}
