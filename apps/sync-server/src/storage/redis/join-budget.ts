import { randomBytes } from 'node:crypto';
import { type JoinBudgetStore, checkJoinBudget } from '../../joins/join-budget.js';
import { JOIN_WINDOW_MS } from '../../limits/constants.js';
import type { RateResult } from '../../limits/rate-limiter.js';
import { JOIN_BUDGET } from './scripts.js';
import type { RedisContext } from './unit-of-work.js';

/**
 * The reply of JOIN_BUDGET (#41 security JB4): `{'ok'}` accepts; `{'rate',
 * ms}` refuses with `ms` clamped to `[1, windowMs]` (a non-integer becomes
 * 1). Anything else throws: a reply never accepts by accident.
 */
export function parseJoinBudgetReply(reply: unknown, windowMs: number): RateResult {
  if (Array.isArray(reply)) {
    const [status, value] = reply as unknown[];
    if (status === 'ok' && reply.length === 1) return { ok: true };
    if (status === 'rate' && reply.length === 2) {
      const ms = Number(value);
      const retryAfterMs = Number.isSafeInteger(ms) ? Math.min(Math.max(ms, 1), windowMs) : 1;
      return { ok: false, retryAfterMs };
    }
  }
  throw new Error('join budget: unexpected reply');
}

/**
 * The per-app join-attempt budget in Redis (#41): one JOIN_BUDGET step per
 * attempt on `lj:<ns>`, atomic over every instance on the prefix. The time
 * is the server clock (`ctx.now()`), as in the memory budget. App-scoped:
 * no group lease and no instance fence (like code releases, security C11).
 * Nothing is caught here: a StorageUnavailableError closes the connection
 * with `1001` (ADR 0024), a StorageReplyError is INTERNAL_ERROR. Nothing is
 * logged; the member is random and carries nothing (JB5).
 */
export class RedisJoinBudget implements JoinBudgetStore {
  constructor(
    private readonly ctx: RedisContext,
    private readonly windowMs: number = JOIN_WINDOW_MS,
  ) {}

  async tryAcquire(namespace: string, limit: number): Promise<RateResult> {
    checkJoinBudget(limit, this.windowMs);
    const now = Math.floor(this.ctx.now());
    if (!Number.isSafeInteger(now) || now < 0) throw new RangeError('join budget: invalid time');
    const reply = await this.ctx.link.script(
      JOIN_BUDGET,
      [this.ctx.keys.appJoinBudget(namespace)],
      [String(now), String(limit), String(this.windowMs), randomBytes(8).toString('hex')],
    );
    return parseJoinBudgetReply(reply, this.windowMs);
  }

  /** Nothing local to forget: the counts live in Redis and expire by TTL. */
  clear(): void {
    return undefined;
  }

  /** Nothing is tracked locally. */
  get size(): number {
    return 0;
  }
}
