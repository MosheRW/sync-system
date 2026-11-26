import { JOIN_WINDOW_MS } from '../limits/constants.js';
import { type RateResult, SlidingWindowRateLimiter } from '../limits/rate-limiter.js';

/** The largest per-app join budget a store accepts (#41 security S6). */
export const MAX_JOIN_BUDGET_LIMIT = 10_000;
/** The longest join budget window a store accepts (#41 security S6). */
export const MAX_JOIN_BUDGET_WINDOW_MS = 3_600_000;

/**
 * Throws unless `limit` and `windowMs` are positive safe integers within
 * the caps (#41 security S6): they bound the stored members and the TTL.
 */
export function checkJoinBudget(limit: number, windowMs: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_JOIN_BUDGET_LIMIT) {
    throw new RangeError('join budget: invalid limit');
  }
  if (!Number.isSafeInteger(windowMs) || windowMs < 1 || windowMs > MAX_JOIN_BUDGET_WINDOW_MS) {
    throw new RangeError('join budget: invalid window');
  }
}

/**
 * The per-app join-attempt budget (#10 AC28, #41): at most `limit` accepted
 * attempts per app in any window. A sliding log: only accepted attempts are
 * recorded; a refusal reports when the oldest one leaves the window. In
 * memory for one instance, in Redis (shared by every instance) with Redis.
 */
export interface JoinBudgetStore {
  /** Charges one attempt of `namespace`, or refuses it with `retryAfterMs`. */
  tryAcquire(namespace: string, limit: number): Promise<RateResult>;
  /** Forgets every local count (server shutdown). */
  clear(): void;
  /** Number of locally tracked apps. For tests only. */
  readonly size: number;
}

/** The process-local budget (one instance, no Redis): today's limiter. */
export class MemoryJoinBudget implements JoinBudgetStore {
  private readonly limiter: SlidingWindowRateLimiter;

  constructor(
    now: () => number,
    private readonly windowMs: number = JOIN_WINDOW_MS,
  ) {
    this.limiter = new SlidingWindowRateLimiter(now, windowMs);
  }

  tryAcquire(namespace: string, limit: number): Promise<RateResult> {
    try {
      checkJoinBudget(limit, this.windowMs);
      return Promise.resolve(this.limiter.tryAcquire(namespace, limit));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  clear(): void {
    this.limiter.clear();
  }

  get size(): number {
    return this.limiter.size;
  }
}
