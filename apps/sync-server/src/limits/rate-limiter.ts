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
