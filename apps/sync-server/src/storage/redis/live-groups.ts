import { GROUP_ID_PATTERN } from '@sync-system/protocol';
import {
  type CreateBudget,
  type LiveGroupsStore,
  type ReserveResult,
  checkBudget,
  checkExpiry,
} from '../../groups/live-groups.js';
import { KeyPartError } from './keys.js';
import { RESERVE_LIVE } from './scripts.js';
import type { CommitPlan, RedisContext, RedisWorkSource } from './unit-of-work.js';

/** A number as a Redis argument: shortest round-trip text, never NaN or infinite. */
function arg(value: number): string {
  return String(value);
}

/**
 * Live groups per app and the app's create budget in Redis (#12 3.1): one
 * RESERVE_LIVE step checks the budget and the cap and adds the group, over
 * every instance. `now` is Redis TIME inside the script (L7). Like
 * `RedisCodeIndex.claim`, a fresh reservation of a running task is undone
 * if the task or its commit fails (best effort: its score bounds it
 * anyway; the budget charge is not refunded). A release inside a task is
 * part of the task's commit.
 */
export class RedisLiveGroups implements LiveGroupsStore {
  constructor(
    private readonly ctx: RedisContext,
    private readonly work: RedisWorkSource,
  ) {}

  private member(groupId: string): string {
    if (!GROUP_ID_PATTERN.test(groupId)) throw new KeyPartError('groupId');
    return groupId;
  }

  async reserve(namespace: string, groupId: string, budget: CreateBudget): Promise<ReserveResult> {
    checkBudget(budget);
    const member = this.member(groupId);
    const { keys } = this.ctx;
    const set = keys.appLive(namespace);
    const reply = await this.ctx.link.script(
      RESERVE_LIVE,
      [set, keys.appCreateBudget(namespace)],
      [
        'reserve',
        member,
        arg(budget.expiresAt),
        arg(budget.cap),
        arg(budget.burst),
        arg(budget.refillPerMinute),
      ],
    );
    const [status, value] = Array.isArray(reply) ? (reply as unknown[]) : [];
    if (status === 'rate') {
      const ms = Number(value);
      return {
        ok: false,
        reason: 'rate',
        retryAfterMs: Number.isSafeInteger(ms) && ms > 0 ? ms : 1,
      };
    }
    if (status === 'cap') return { ok: false, reason: 'cap' };
    if (status !== 'ok') throw new Error('live groups: unexpected reply');
    if (Number(value) === 1) this.undoOnAbandon(set, member);
    return { ok: true };
  }

  async register(namespace: string, groupId: string, expiresAt: number): Promise<void> {
    checkExpiry(expiresAt);
    const member = this.member(groupId);
    const { keys } = this.ctx;
    const set = keys.appLive(namespace);
    const reply = await this.ctx.link.script(
      RESERVE_LIVE,
      [set, keys.appCreateBudget(namespace)],
      ['register', member, arg(expiresAt)],
    );
    const [, fresh] = Array.isArray(reply) ? (reply as unknown[]) : [];
    if (Number(fresh) === 1) this.undoOnAbandon(set, member);
  }

  /** A failed task or commit drops a fresh slot again (a held one stays). */
  private undoOnAbandon(set: string, member: string): void {
    this.work.current()?.onAbandon(async () => {
      const plan = this.planFor();
      plan.zrem(set, member);
      await plan.run(this.ctx.link);
    });
  }

  async release(namespace: string, groupId: string): Promise<void> {
    const set = this.ctx.keys.appLive(namespace);
    const member = this.member(groupId);
    const running = this.work.current();
    if (running !== undefined) {
      running.addStep((plan) => plan.zrem(set, member));
      return;
    }
    const plan = this.planFor();
    plan.zrem(set, member);
    await plan.run(this.ctx.link);
  }

  /** Releasing a slot needs no instance fence (like code releases, security C11). */
  private planFor(): CommitPlan {
    return this.work.plan(false);
  }

  /** Nothing local to forget: the set and the bucket live in Redis. */
  clear(): void {
    return undefined;
  }
}
