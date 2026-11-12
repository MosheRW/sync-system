import { ALPHA_CODE_PATTERN, GROUP_CODE_PATTERN } from '@sync-system/protocol';
import type { EndedGroupsStore, EvictionLogger } from '../../groups/ended-groups.js';
import { endedRef } from '../../groups/ended-groups.js';
import type { HeldLease } from '../../groups/group-lock.js';
import { TIMER_KINDS } from '../../groups/group-timers.js';
import { MAX_ENDED_GROUPS } from '../../limits/constants.js';
import type { CommitPlan, CommitResult, RedisContext, RedisWorkSource } from './unit-of-work.js';
import { PRUNE_ENDED } from './scripts.js';
import { decodeRegistry, instancesOf } from './attachments.js';

/** Most frequent eviction and closure warning: once per minute each (as in memory). */
const WARN_INTERVAL_MS = 60_000;
/** Refs per set looked at by one prune (#35 F13). */
const PRUNE_BATCH = 1000;

/**
 * Ended groups in Redis (#13 6.9, #35 AC13): hashed refs only, with the
 * same cap, eviction order and recovery closure as `EndedGroups`, in one
 * Lua step inside the commit that ends the group. Deadlines and guards are
 * compared with the server's clock; the key TTL only cleans up. A value
 * that fails its check fails closed (ended, closed; security C1).
 */
export class RedisEndedGroups implements EndedGroupsStore {
  private evicted = 0;
  private lastWarnAt = Number.NEGATIVE_INFINITY;
  private readonly closureWarnedAt = new Map<string, number>();

  constructor(
    private readonly ctx: RedisContext,
    private readonly work: RedisWorkSource,
    private readonly logger: EvictionLogger,
    private readonly cap: number = MAX_ENDED_GROUPS,
  ) {}

  async remember(
    namespace: string,
    groupId: string,
    deadline: number,
    guardUntil?: number,
  ): Promise<void> {
    if (deadline <= this.ctx.now()) return;
    const add = (plan: CommitPlan) => this.addTo(plan, namespace, groupId, deadline, guardUntil);
    const running = this.work.current();
    if (running !== undefined) {
      running.addStep(add);
      running.afterCommit((result) => this.warn(result));
      return;
    }
    const plan = this.work.plan();
    add(plan);
    this.warn(await plan.run(this.ctx.link));
  }

  /** Adds the `remember` step of an ended group to `plan` (deadline in the future). */
  addTo(
    plan: CommitPlan,
    namespace: string,
    groupId: string,
    deadline: number,
    guardUntil?: number,
  ): void {
    const now = this.ctx.now();
    const { keys } = this.ctx;
    const ref = endedRef(namespace, groupId);
    plan.raw(
      'remember',
      {
        e: keys.ended(ref),
        pl: keys.endedPlain(),
        gu: keys.endedGuarded(),
        cl: keys.endedClosed(),
        sq: keys.endedSeq(),
      },
      {
        ep: `${keys.base}:e:`,
        ref,
        ns: namespace,
        d: String(deadline),
        g: guardUntil === undefined ? '' : String(guardUntil),
        x: String(Math.max(1, Math.ceil(deadline - now))),
        cap: String(this.cap),
        now: String(now),
      },
    );
  }

  /**
   * Ends a group whose stored document is invalid (#35 security C1, user
   * decision in QA round 1): its keys and timers go and it is remembered as
   * ended until `deadline`, so no token can recreate it. One commit. The
   * join codes the document still names are freed too (#39, security C17):
   * each one that matches its pattern is deleted only while it still points
   * at this group; anything unreadable expires with its TTL.
   */
  async endInvalid(namespace: string, groupId: string, deadline: number): Promise<void> {
    // Under the group lease and the instance fence (security C17).
    await this.work.withLease(namespace, groupId, async (lease) => {
      await this.endInvalidLeased(namespace, groupId, deadline, lease);
    });
  }

  private async endInvalidLeased(
    namespace: string,
    groupId: string,
    deadline: number,
    lease: HeldLease | undefined,
  ): Promise<void> {
    const { keys } = this.ctx;
    const reply = await this.ctx.link.send([
      'MGET',
      keys.group(namespace, groupId),
      keys.attachments(namespace, groupId),
    ]);
    const [raw, registryText] = Array.isArray(reply) ? (reply as unknown[]) : [];
    const plan = this.work.plan();
    if (lease !== undefined) plan.eq(lease.key, lease.token, 'lease');
    this.addTo(plan, namespace, groupId, deadline);
    const codes = lenientCodes(raw);
    if (codes.groupCode !== undefined) {
      plan.deleq(keys.groupCode(namespace, codes.groupCode), groupId);
    }
    if (codes.alphaCode !== undefined) {
      plan.deleq(keys.alphaCode(namespace, codes.alphaCode), groupId);
    }
    plan.del(keys.group(namespace, groupId));
    plan.del(keys.position(namespace, groupId));
    plan.zrem(keys.live(), keys.liveMember(namespace, groupId));
    plan.del(keys.timers(namespace, groupId));
    for (const kind of TIMER_KINDS) plan.zrem(keys.due(), keys.dueMember(namespace, groupId, kind));
    // The registry goes; a valid one also names the instance sets to clean
    // (an invalid one: those sets drop the group when the instance is forgotten).
    plan.del(keys.attachments(namespace, groupId));
    const registry = typeof registryText === 'string' ? decodeRegistry(registryText) : 'invalid';
    if (registry !== 'invalid') {
      for (const id of instancesOf(registry)) {
        plan.srem(keys.instanceGroups(id), keys.liveMember(namespace, groupId));
      }
    }
    this.warn(await plan.run(this.ctx.link));
  }

  async has(namespace: string, groupId: string): Promise<boolean> {
    const raw = await this.ctx.link.send([
      'GET',
      this.ctx.keys.ended(endedRef(namespace, groupId)),
    ]);
    if (raw === null || raw === undefined) return false;
    const deadline = parseEntryDeadline(raw);
    if (deadline === undefined) {
      this.ctx.logger.error({ event: 'store_document_invalid' }, 'stored ended entry is invalid');
      return true;
    }
    return deadline > this.ctx.now();
  }

  async isRecoveryClosed(namespace: string): Promise<boolean> {
    const raw = await this.ctx.link.send(['HGET', this.ctx.keys.endedClosed(), namespace]);
    if (raw === null || raw === undefined) return false;
    const until = typeof raw === 'string' && /^[0-9]{1,16}$/.test(raw) ? Number(raw) : undefined;
    if (until === undefined) {
      this.ctx.logger.error(
        { event: 'store_document_invalid' },
        'stored recovery closure is invalid',
      );
      return true;
    }
    return until > this.ctx.now();
  }

  /** Drops passed refs and closures (F13); Redis TTLs drop the entries themselves. */
  async sweep(): Promise<void> {
    const { keys } = this.ctx;
    await this.ctx.link.script(
      PRUNE_ENDED,
      [keys.endedPlain(), keys.endedGuarded(), keys.endedClosed()],
      [`${keys.base}:e:`, String(this.ctx.now()), String(PRUNE_BATCH)],
    );
  }

  /** The same warnings as `EndedGroups`, rate-limited the same way. */
  private warn(result: CommitResult): void {
    const now = this.ctx.now();
    for (const namespace of result.closed) {
      const last = this.closureWarnedAt.get(namespace);
      if (last !== undefined && now - last < WARN_INTERVAL_MS) continue;
      this.closureWarnedAt.set(namespace, now);
      this.logger.warn(
        { event: 'ended_groups_recovery_closed', namespace },
        'ended-group memory is full of guarded entries; recovery closed for the app',
      );
    }
    this.evicted += result.evicted;
    if (this.evicted === 0 || now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    this.logger.warn(
      { event: 'ended_groups_evicting', count: this.evicted },
      'ended-group memory is full; evicting the oldest entries',
    );
    this.evicted = 0;
  }
}

/** The deadline of a stored entry `{ns, d, g?}`, or undefined when invalid. */
function parseEntryDeadline(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { ns, d, g } = value as { ns?: unknown; d?: unknown; g?: unknown };
  if (typeof ns !== 'string' || typeof d !== 'number' || !Number.isSafeInteger(d) || d < 0) {
    return undefined;
  }
  if (g !== undefined && (typeof g !== 'number' || !Number.isFinite(g))) return undefined;
  return d;
}

/**
 * The join codes an invalid document still names (#39, security C17): read
 * leniently (any part may be missing or malformed), and only values that
 * match their pattern, so nothing else can reach a key name.
 */
export function lenientCodes(raw: unknown): { groupCode?: string; alphaCode?: string } {
  if (typeof raw !== 'string') return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  const codes = (value as { record?: { codes?: unknown } } | null)?.record?.codes;
  if (typeof codes !== 'object' || codes === null) return {};
  const { groupCode, alphaCode } = codes as { groupCode?: unknown; alphaCode?: unknown };
  return {
    ...(typeof groupCode === 'string' && GROUP_CODE_PATTERN.test(groupCode) ? { groupCode } : {}),
    ...(typeof alphaCode === 'string' && ALPHA_CODE_PATTERN.test(alphaCode) ? { alphaCode } : {}),
  };
}
