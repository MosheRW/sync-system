import {
  TIMER_KINDS,
  type TimerBackend,
  type TimerData,
  type TimerFire,
  type TimerKind,
} from '../../groups/group-timers.js';
import { TIMER_LEASE_MS, TIMER_POLL_MS } from '../../limits/constants.js';
import { safeErr } from '../../logging/logger.js';
import type { Cancel, Scheduler } from '../../time/scheduler.js';
import { parseMember } from './keys.js';
import { CLAIM_DUE } from './scripts.js';
import type { CommitPlan, PlanGroups, RedisContext, RedisWorkSource } from './unit-of-work.js';

/**
 * Due timers claimed, and expired live-group members freed (#47), by one
 * CLAIM_DUE call at most. A full batch of either runs the poll again.
 */
const CLAIM_BATCH = 64;

type Fire = TimerFire;

/** `{at, data?}` of a stored timer; undefined when invalid (security C1). */
function parseTimer(raw: unknown): { data: TimerData | undefined } | undefined {
  if (typeof raw !== 'string') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { at, data } = value as { at?: unknown; data?: unknown };
  if (typeof at !== 'number' || !Number.isSafeInteger(at)) return undefined;
  if (data === undefined) return { data: undefined };
  const { term, at: dataAt } = data as { term?: unknown; at?: unknown };
  if (
    typeof term !== 'number' ||
    !Number.isSafeInteger(term) ||
    typeof dataAt !== 'number' ||
    !Number.isSafeInteger(dataAt)
  ) {
    return undefined;
  }
  return { data: { term, at: dataAt } };
}

/**
 * Group timers in Redis (#35 ADR 0013, AC7, AC12): one hash per group
 * (kind -> `{at, data}`) and one due set (member `ns:gid:kind`, score = due
 * time, or lease end while claimed). Arms and clears are written with the
 * state they guard, in the task's commit. A poll runs at the earliest known
 * due time and at least every TIMER_POLL_MS; it claims due timers with a
 * lease (Lua) and fires them; the handler's commit removes the timer unless
 * it was armed again. A timer whose handler failed runs again after the
 * lease. Each poll also drops members of groups that are gone (F13).
 */
export class RedisTimerBackend implements TimerBackend {
  private fire: Fire | undefined;
  private interval: NodeJS.Timeout | undefined;
  private wake: { at: number; cancel: Cancel } | undefined;
  private polling: Promise<void> | undefined;
  private again = false;
  private stopped = false;

  constructor(
    private readonly ctx: RedisContext,
    private readonly work: RedisWorkSource,
    private readonly scheduler: Scheduler,
    /** How long a claimed timer is leased (ADR 0013); tests shorten it. */
    private readonly leaseMs: number = TIMER_LEASE_MS,
  ) {}

  get size(): number {
    return this.wake === undefined ? 0 : 1;
  }

  start(fire: Fire): void {
    this.fire = fire;
  }

  /** Starts the safety poll (the server calls this once storage is ready). */
  startPolling(): void {
    if (this.interval !== undefined) return;
    this.stopped = false;
    this.interval = setInterval(() => void this.poll(), TIMER_POLL_MS);
    this.interval.unref();
  }

  arm(namespace: string, groupId: string, kind: TimerKind, at: number, data?: TimerData): void {
    const { keys } = this.ctx;
    const value = JSON.stringify(data === undefined ? { at } : { at, data });
    this.write((plan, groups) => {
      const end = groups.expiry(namespace, groupId);
      if (end === undefined) {
        this.ctx.logger.warn({ event: 'timer_without_group', kind }, 'timer for a missing group');
        return;
      }
      plan.hset(keys.timers(namespace, groupId), kind, value);
      plan.keep(keys.timers(namespace, groupId), end);
      plan.zadd(keys.due(), at, keys.dueMember(namespace, groupId, kind));
      plan.extend(keys.due(), end);
    }, at);
  }

  clear(namespace: string, groupId: string, kind: TimerKind): void {
    const { keys } = this.ctx;
    this.write((plan) => {
      plan.hdel(keys.timers(namespace, groupId), kind);
      plan.zrem(keys.due(), keys.dueMember(namespace, groupId, kind));
    });
  }

  clearGroup(namespace: string, groupId: string): void {
    const { keys } = this.ctx;
    this.write((plan) => {
      plan.del(keys.timers(namespace, groupId));
      for (const kind of TIMER_KINDS)
        plan.zrem(keys.due(), keys.dueMember(namespace, groupId, kind));
    });
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.interval);
    this.interval = undefined;
    this.wake?.cancel();
    this.wake = undefined;
  }

  /**
   * Runs every due timer once (startup: deadlines that passed while the
   * server was down, AC12). Resolves when the handlers were fired.
   */
  async runDue(): Promise<void> {
    await this.poll();
  }

  /** Buffers `step` in the running task's commit, or commits it now. */
  private write(step: (plan: CommitPlan, groups: PlanGroups) => void, wakeAt?: number): void {
    const running = this.work.current();
    if (running !== undefined) {
      running.addStep(step);
      if (wakeAt !== undefined) running.afterCommit(() => this.wakeAt(wakeAt));
      return;
    }
    // Outside a group task (tests): no group is known, so no expiry; commit
    // what does not need one.
    const plan = this.work.plan();
    step(plan, { expiry: () => this.ctx.now() + this.leaseMs });
    plan
      .run(this.ctx.link)
      .then(() => {
        if (wakeAt !== undefined) this.wakeAt(wakeAt);
      })
      .catch((err: unknown) => {
        this.ctx.logger.warn(
          { event: 'timer_write_failed', err: safeErr(err) },
          'timer write failed',
        );
      });
  }

  /** A local wake-up at the earliest known due time. */
  private wakeAt(at: number): void {
    if (this.stopped) return;
    if (this.wake !== undefined && this.wake.at <= at) return;
    this.wake?.cancel();
    const cancel = this.scheduler.at(at, () => {
      this.wake = undefined;
      void this.poll();
    });
    this.wake = { at, cancel };
  }

  private poll(): Promise<void> {
    if (this.polling !== undefined) {
      this.again = true;
      return this.polling;
    }
    this.polling = this.pollLoop().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async pollLoop(): Promise<void> {
    do {
      this.again = false;
      if (this.stopped && this.interval === undefined && this.fire === undefined) return;
      if (this.ctx.link.state !== 'connected') return;
      let result: { claimed: number; freed: number };
      try {
        result = await this.claimDue();
      } catch (err) {
        this.ctx.logger.warn(
          { event: 'timer_poll_failed', err: safeErr(err) },
          'timer poll failed',
        );
        return;
      }
      if (result.claimed >= CLAIM_BATCH || result.freed >= CLAIM_BATCH) this.again = true;
    } while (this.again);
  }

  /**
   * Claims due timers with a lease and fires each. Returns how many were
   * claimed, and how many expired live-group members the call freed.
   */
  private async claimDue(): Promise<{ claimed: number; freed: number }> {
    const { keys } = this.ctx;
    const now = this.ctx.now();
    const leaseEnd = now + this.leaseMs;
    const reply = await this.ctx.link.script(
      CLAIM_DUE,
      [keys.due(), keys.live()],
      [`${keys.base}:t:`, String(now), String(leaseEnd), String(CLAIM_BATCH), `${keys.base}:lg:`],
    );
    const items = Array.isArray(reply) ? (reply as unknown[]) : [];
    // `{freed, member, timerJson, ...}`: anything else (a script text
    // mismatch) would shift every pair, so nothing of it is used (#47 L2).
    const freed = Number(items[0]);
    if (!Number.isSafeInteger(freed) || freed < 0 || items.length % 2 !== 1) {
      this.ctx.logger.error({ event: 'timer_claim_invalid' }, 'timer claim reply is invalid');
      return { claimed: 0, freed: 0 };
    }
    for (let i = 1; i + 1 < items.length; i += 2) {
      const member = String(items[i]);
      const parsed = parseMember(member);
      const timer = parseTimer(items[i + 1]);
      if (parsed?.kind === undefined || timer === undefined) {
        // Invalid timer data: drop the timer, keep the group (C1).
        this.ctx.logger.error({ event: 'store_document_invalid' }, 'stored timer is invalid');
        await this.ctx.link.send(['ZREM', keys.due(), member]);
        continue;
      }
      const { namespace, groupId, kind } = parsed;
      this.ctx.logger.debug({ event: 'timer_claimed', kind }, 'timer claimed');
      this.fire?.(namespace, groupId, kind, timer.data, () => this.consume(parsed, leaseEnd));
    }
    return { claimed: (items.length - 1) / 2, freed };
  }

  /** In the handler's task: the timer is done unless the handler arms it again. */
  private consume(
    timer: { namespace: string; groupId: string; kind?: TimerKind },
    leaseEnd: number,
  ): void {
    const { keys } = this.ctx;
    const { namespace, groupId, kind } = timer;
    if (kind === undefined) return;
    this.write((plan) => {
      plan.consume(
        keys.due(),
        keys.dueMember(namespace, groupId, kind),
        leaseEnd,
        keys.timers(namespace, groupId),
        kind,
      );
    });
  }
}
