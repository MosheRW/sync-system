/**
 * Live groups per app and the app's create budget (#12 architecture 3.1).
 * The memory and Redis stores share the bucket arithmetic below, so both
 * give the same answers and the same `retryAfterMs`.
 */

const MINUTE_MS = 60_000;

/**
 * Largest `retryAfterMs` and bucket TTL (#12 R14, L8): a safe integer
 * (about 317 years), so a tiny sustained rate can never produce an unsafe
 * number, exponent notation in a Redis argument or a fractional TTL.
 */
export const MAX_RETRY_AFTER_MS = 1e13;

/** Per-app create budget and limits (#12). Values validated by `reserve`. */
export interface CreateBudget {
  /** Server clock; the memory store's clock. Redis uses its own TIME instead (L7). */
  now: number;
  /** The group's end bound (instance clock), its score and the `u` horizon. */
  expiresAt: number;
  /** Bucket size, safe integer >= 1. */
  burst: number;
  /** Refill per minute, finite and > 0. */
  refillPerMinute: number;
  /** Live-group cap, safe integer >= 1. */
  cap: number;
}

export type ReserveResult =
  { ok: true } | { ok: false; reason: 'rate'; retryAfterMs: number } | { ok: false; reason: 'cap' };

/** Live groups per app (#12): the cap's count and the create budget. Never logged. */
export interface LiveGroupsStore {
  /**
   * Charges the app's budget and adds `groupId` unless the budget is empty
   * or the app is at the cap. Throws on invalid numbers. Idempotent for a
   * held ID (no charge).
   */
  reserve(namespace: string, groupId: string, budget: CreateBudget): Promise<ReserveResult>;
  /** Adds `groupId` without budget or cap (recreation, Q-4). */
  register(namespace: string, groupId: string, expiresAt: number): Promise<void>;
  /** Removes `groupId` (group ended, invalid, or its create failed). */
  release(namespace: string, groupId: string): Promise<void>;
  /** Forgets local state (server shutdown). */
  clear(): void;
}

/**
 * The bucket (#12 3.1): `t` tokens (a float) at `a` (ms), and the strictest
 * recent parameters (R13 for L6): `r` the slowest refill per minute, `b`
 * the smallest burst, `u` until when they hold (ms).
 */
export interface BucketState {
  t: number;
  a: number;
  r: number;
  b: number;
  u: number;
}

export type BucketDecision =
  { ok: true; next: BucketState; ttlMs: number } | { ok: false; retryAfterMs: number };

/** Throws (a programming error) unless the budget's numbers are valid (R7, L2). */
export function checkBudget(budget: CreateBudget): void {
  const { cap, burst, refillPerMinute, now, expiresAt } = budget;
  if (!Number.isSafeInteger(cap) || cap < 1) throw new RangeError('live groups: invalid cap');
  if (!Number.isSafeInteger(burst) || burst < 1) {
    throw new RangeError('live groups: invalid burst');
  }
  if (!Number.isFinite(refillPerMinute) || !(refillPerMinute > 0)) {
    throw new RangeError('live groups: invalid refill');
  }
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt)) {
    throw new RangeError('live groups: invalid time');
  }
}

/** Throws unless `expiresAt` is a finite number. */
export function checkExpiry(expiresAt: number): void {
  if (!Number.isFinite(expiresAt)) throw new RangeError('live groups: invalid time');
}

/**
 * One budget step at `now` (#12 3.1). The effective `r`/`b`/`u` come first
 * (the strictest values while `now < u`), then the refill, then the
 * refusal (nothing to write) or the charge. A missing bucket is full. The
 * RESERVE_LIVE script does the same arithmetic in the same order.
 */
export function bucketStep(
  state: BucketState | undefined,
  now: number,
  budget: Pick<CreateBudget, 'expiresAt' | 'burst' | 'refillPerMinute'>,
): BucketDecision {
  let r: number;
  let b: number;
  let u: number;
  let tokens: number;
  let at: number;
  if (state === undefined) {
    r = budget.refillPerMinute;
    b = budget.burst;
    u = budget.expiresAt;
    tokens = b;
    at = now;
  } else {
    if (now < state.u) {
      r = Math.min(state.r, budget.refillPerMinute);
      b = Math.min(state.b, budget.burst);
      u = Math.max(state.u, budget.expiresAt);
    } else {
      r = budget.refillPerMinute;
      b = budget.burst;
      u = budget.expiresAt;
    }
    tokens = Math.min(b, state.t + (Math.max(0, now - state.a) * r) / MINUTE_MS);
    at = state.a;
  }
  if (tokens < 1) {
    return {
      ok: false,
      retryAfterMs: Math.min(Math.ceil(((1 - tokens) * MINUTE_MS) / r), MAX_RETRY_AFTER_MS),
    };
  }
  const t = tokens - 1;
  const next: BucketState = { t, a: Math.max(at, now), r, b, u };
  const ttlMs = Math.min(
    Math.ceil(Math.max(((b - t) * MINUTE_MS) / r, u - now) + 1_000),
    MAX_RETRY_AFTER_MS,
  );
  return { ok: true, next, ttlMs };
}

/** True when the bucket is full again at `now` and its strict values have lapsed. */
function bucketIdle(state: BucketState | undefined, now: number): boolean {
  if (state === undefined) return true;
  if (now < state.u) return false;
  return state.t + (Math.max(0, now - state.a) * state.r) / MINUTE_MS >= state.b;
}

interface AppLive {
  /** Group ID -> its end bound. */
  readonly live: Map<string, number>;
  bucket: BucketState | undefined;
  /** When the bucket would expire in Redis (its TTL); past it, the bucket is full. */
  bucketUntil: number;
}

/**
 * The memory store (#12 3.1): with memory storage there is one process, so
 * "global" and "per process" are the same. Every method body is
 * synchronous, so the check, the charge and the add are atomic in-process
 * (like `CodeIndex`). An app's entry is dropped once it has no live group
 * and its bucket is full with its strict values lapsed, so entries are
 * bounded by apps with live groups or recent creates. A restart loses
 * everything (the bucket starts full; recreations register, Q-4).
 */
export class MemoryLiveGroups implements LiveGroupsStore {
  private readonly apps = new Map<string, AppLive>();

  constructor(private readonly clock: () => number = Date.now) {}

  private app(namespace: string): AppLive {
    let app = this.apps.get(namespace);
    if (app === undefined) {
      app = { live: new Map(), bucket: undefined, bucketUntil: 0 };
      this.apps.set(namespace, app);
    }
    return app;
  }

  private prune(app: AppLive, now: number): void {
    for (const [groupId, expiresAt] of app.live) {
      if (expiresAt < now) app.live.delete(groupId);
    }
  }

  private tidy(namespace: string, app: AppLive, now: number): void {
    if (app.live.size === 0 && bucketIdle(app.bucket, now)) this.apps.delete(namespace);
  }

  reserve(namespace: string, groupId: string, budget: CreateBudget): Promise<ReserveResult> {
    try {
      return Promise.resolve(this.reserveNow(namespace, groupId, budget));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** The whole reserve, synchronous: the check, the charge and the add are one step. */
  private reserveNow(namespace: string, groupId: string, budget: CreateBudget): ReserveResult {
    checkBudget(budget);
    const { now } = budget;
    const app = this.app(namespace);
    this.prune(app, now);
    const held = app.live.get(groupId);
    if (held !== undefined) {
      if (budget.expiresAt > held) app.live.set(groupId, budget.expiresAt);
      return { ok: true };
    }
    // An expired bucket is a missing one: full (as with the Redis TTL).
    const state = now < app.bucketUntil ? app.bucket : undefined;
    const decision = bucketStep(state, now, budget);
    if (!decision.ok) {
      this.tidy(namespace, app, now);
      return { ok: false, reason: 'rate', retryAfterMs: decision.retryAfterMs };
    }
    if (app.live.size >= budget.cap) {
      this.tidy(namespace, app, now);
      return { ok: false, reason: 'cap' };
    }
    app.bucket = decision.next;
    app.bucketUntil = now + decision.ttlMs;
    app.live.set(groupId, budget.expiresAt);
    return { ok: true };
  }

  register(namespace: string, groupId: string, expiresAt: number): Promise<void> {
    try {
      checkExpiry(expiresAt);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const app = this.app(namespace);
    this.prune(app, this.clock());
    const held = app.live.get(groupId);
    if (held === undefined || expiresAt > held) app.live.set(groupId, expiresAt);
    return Promise.resolve();
  }

  release(namespace: string, groupId: string): Promise<void> {
    const app = this.apps.get(namespace);
    if (app !== undefined) {
      app.live.delete(groupId);
      this.tidy(namespace, app, this.clock());
    }
    return Promise.resolve();
  }

  /** Live groups of `namespace` now (tests). */
  count(namespace: string): number {
    const app = this.apps.get(namespace);
    if (app === undefined) return 0;
    this.prune(app, this.clock());
    return app.live.size;
  }

  /** Apps with an entry (tests: bounded state). */
  get size(): number {
    return this.apps.size;
  }

  clear(): void {
    this.apps.clear();
  }
}
