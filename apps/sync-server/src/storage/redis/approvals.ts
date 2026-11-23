import { JOIN_REQUEST_ID_PATTERN, MAX_DISPLAY_NAME_LENGTH } from '@mosherw/sync-system-protocol';
import { z } from 'zod';
import type { Session } from '../../groups/session.js';
import { MAX_PENDING_APPROVALS_PER_GROUP } from '../../limits/constants.js';
import { newRequestId } from '../../joins/approval-queue.js';
import type {
  ApprovalStore,
  NewRequest,
  PendingRequest,
  TakenRequest,
} from '../../joins/approval-store.js';
import { INSTANCE_ID_PATTERN } from './keys.js';
import type { RedisContext, RedisUnitOfWork, RedisWorkSource } from './unit-of-work.js';

/** A stored request `{i, n?, d}`: the joiner's instance, its chosen name, the deadline (C1). */
const requestSchema = z
  .object({
    i: z.string().regex(INSTANCE_ID_PATTERN),
    n: z
      .string()
      .min(1)
      .max(MAX_DISPLAY_NAME_LENGTH * 4)
      .optional(),
    d: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

interface Stored {
  rid: string;
  /** The joiner's instance. */
  i: string;
  n: string | undefined;
  d: number;
}

/** One group's requests as a task sees them. */
interface GroupRequests {
  namespace: string;
  groupId: string;
  /** Live requests (deadline in the future), oldest first. */
  live: Map<string, Stored>;
  /** Requests whose deadline passed, for the `approvalDue` timer. */
  due: Map<string, Stored>;
}

function splitKey(groupKey: string): { namespace: string; groupId: string } {
  const at = groupKey.indexOf(':');
  return { namespace: groupKey.slice(0, at), groupId: groupKey.slice(at + 1) };
}

/** A queue member `<rid>.<instanceId>`: the joiner's instance outlives the request key. */
function memberOf(entry: Pick<Stored, 'rid' | 'i'>): string {
  return `${entry.rid}.${entry.i}`;
}

function parseMember(member: string): { rid: string; i: string } | undefined {
  const [rid, i, extra] = member.split('.');
  if (extra !== undefined || rid === undefined || i === undefined) return undefined;
  if (!JOIN_REQUEST_ID_PATTERN.test(rid) || !INSTANCE_ID_PATTERN.test(i)) return undefined;
  return { rid, i };
}

/**
 * Pending method B requests in Redis (#35 architecture 12.9, AC7, AC20):
 * one key per request `P:ap:<ns>:<gid>:<rid>` (`{i, n?, d}`, expiring at
 * its deadline, never after E) and a queue `P:aq:<ns>:<gid>` (member
 * `<rid>.<instance>`, score = deadline). Reads and writes join the task's
 * unit of work: a request is read and deleted in one commit under the
 * group lease, so it settles exactly once. The joiner's session stays on
 * its instance (`joiners`); the `approvalDue` timer settles timeouts.
 */
export class RedisApprovals implements ApprovalStore {
  readonly timed = false;
  /** Joiners waiting here: request ID -> session. */
  private readonly joiners = new Map<string, Session>();
  private readonly loaded = new WeakMap<RedisUnitOfWork, Map<string, GroupRequests>>();

  constructor(
    private readonly ctx: RedisContext,
    private readonly work: RedisWorkSource,
  ) {}

  get size(): number {
    return this.joiners.size;
  }

  private task(): RedisUnitOfWork {
    const running = this.work.current();
    if (running === undefined) throw new Error('approvals need a group task');
    return running;
  }

  /** The group's requests, read once per task (missing or invalid entries are pruned). */
  private async requests(groupKey: string): Promise<GroupRequests> {
    const work = this.task();
    let groups = this.loaded.get(work);
    if (groups === undefined) {
      groups = new Map();
      this.loaded.set(work, groups);
    }
    const known = groups.get(groupKey);
    if (known !== undefined) return known;
    const { namespace, groupId } = splitKey(groupKey);
    const { keys } = this.ctx;
    const queueKey = keys.approvalQueue(namespace, groupId);
    const reply = await this.ctx.link.send(['ZRANGE', queueKey, '0', '-1', 'WITHSCORES']);
    const items = Array.isArray(reply) ? (reply as unknown[]).map(String) : [];
    const members: Array<{ member: string; rid: string; i: string; d: number }> = [];
    const prune: string[] = [];
    for (let at = 0; at + 1 < items.length; at += 2) {
      const member = items[at]!;
      const parsed = parseMember(member);
      const d = Number(items[at + 1]);
      if (parsed === undefined || !Number.isSafeInteger(d)) prune.push(member);
      else members.push({ member, ...parsed, d });
    }
    const values =
      members.length === 0
        ? []
        : ((await this.ctx.link.send([
            'MGET',
            ...members.map((m) => keys.approval(namespace, groupId, m.rid)),
          ])) as unknown[]);
    const now = this.ctx.now();
    const state: GroupRequests = { namespace, groupId, live: new Map(), due: new Map() };
    members.forEach((m, at) => {
      if (m.d <= now) {
        state.due.set(m.rid, { rid: m.rid, i: m.i, n: undefined, d: m.d });
        return;
      }
      const stored = parseRequest(values[at]);
      if (stored === undefined || stored.i !== m.i || stored.d !== m.d) {
        if (values[at] !== null && values[at] !== undefined) {
          this.ctx.logger.error({ event: 'store_document_invalid' }, 'stored request is invalid');
        }
        prune.push(m.member);
        return;
      }
      state.live.set(m.rid, { rid: m.rid, i: m.i, n: stored.n, d: m.d });
    });
    if (prune.length > 0) {
      work.addStep((plan) => {
        for (const member of prune) {
          plan.zrem(queueKey, member);
          const parsed = parseMember(member);
          if (parsed !== undefined) plan.del(keys.approval(namespace, groupId, parsed.rid));
        }
      });
    }
    groups.set(groupKey, state);
    return state;
  }

  /** Removes `entries` from Redis in the task's commit. */
  private remove(state: GroupRequests, entries: readonly Stored[]): void {
    if (entries.length === 0) return;
    const { keys } = this.ctx;
    const { namespace, groupId } = state;
    this.task().addStep((plan) => {
      for (const entry of entries) {
        plan.del(keys.approval(namespace, groupId, entry.rid));
        plan.zrem(keys.approvalQueue(namespace, groupId), memberOf(entry));
      }
    });
  }

  private taken(state: GroupRequests, entry: Stored): TakenRequest {
    const groupKey = `${state.namespace}:${state.groupId}`;
    const self = this.task().instanceId;
    const local = entry.i === self ? this.joiners.get(entry.rid) : undefined;
    const current = local?.pendingJoin?.requestId === entry.rid;
    if (local !== undefined) {
      this.joiners.delete(entry.rid);
      if (current) local.pendingJoin = undefined;
    }
    return {
      requestId: entry.rid,
      groupKey,
      groupId: state.groupId,
      displayName: entry.n,
      deadline: entry.d,
      session: local,
      // A joiner elsewhere is checked there when its effect arrives (Q-B3).
      current: local === undefined ? entry.i !== self : current,
      ...(entry.i === self ? {} : { instance: entry.i }),
    };
  }

  async add(request: NewRequest): Promise<PendingRequest | 'full'> {
    const state = await this.requests(request.groupKey);
    if (state.live.size >= MAX_PENDING_APPROVALS_PER_GROUP) return 'full';
    const work = this.task();
    const self = work.instanceId;
    if (self === undefined) throw new Error('approvals need an instance');
    let rid = newRequestId();
    while (state.live.has(rid) || state.due.has(rid)) rid = newRequestId();
    const entry: Stored = { rid, i: self, n: request.displayName, d: request.deadline };
    state.live.set(rid, entry);
    const { keys } = this.ctx;
    const { namespace, groupId } = state;
    work.addStep((plan, groups) => {
      const end = groups.expiry(namespace, groupId);
      if (end === undefined) return;
      const key = keys.approval(namespace, groupId, rid);
      // Unique across instances too (security C16).
      plan.absent(key, 'request');
      const value = JSON.stringify(
        entry.n === undefined ? { i: self, d: entry.d } : { i: self, n: entry.n, d: entry.d },
      );
      plan.set(key, value, Math.min(entry.d, end));
      plan.zadd(keys.approvalQueue(namespace, groupId), entry.d, memberOf(entry));
      plan.extend(keys.approvalQueue(namespace, groupId), Math.min(entry.d, end));
    });
    const { session } = request;
    session.pendingJoin = { groupKey: request.groupKey, groupId, requestId: rid };
    this.joiners.set(rid, session);
    work.onAbandon(() => {
      if (session.pendingJoin?.requestId === rid) session.pendingJoin = undefined;
      this.joiners.delete(rid);
      return Promise.resolve();
    });
    return {
      requestId: rid,
      groupKey: request.groupKey,
      groupId,
      displayName: entry.n,
      deadline: entry.d,
    };
  }

  async take(groupKey: string, requestId: string): Promise<TakenRequest | undefined> {
    const state = await this.requests(groupKey);
    const entry = state.live.get(requestId);
    if (entry === undefined) return undefined;
    state.live.delete(requestId);
    this.remove(state, [entry]);
    return this.taken(state, entry);
  }

  async takeBySession(session: Session): Promise<TakenRequest | undefined> {
    const pending = session.pendingJoin;
    if (pending === undefined) return undefined;
    const state = await this.requests(pending.groupKey);
    const entry = state.live.get(pending.requestId) ?? state.due.get(pending.requestId);
    if (entry === undefined || this.joiners.get(entry.rid) !== session) {
      this.forgetJoiner(session);
      return undefined;
    }
    state.live.delete(entry.rid);
    state.due.delete(entry.rid);
    this.remove(state, [entry]);
    return this.taken(state, entry);
  }

  async list(groupKey: string): Promise<PendingRequest[]> {
    const state = await this.requests(groupKey);
    return [...state.live.values()]
      .sort((a, b) => a.d - b.d)
      .map((entry) => ({
        requestId: entry.rid,
        groupKey,
        groupId: state.groupId,
        displayName: entry.n,
        deadline: entry.d,
      }));
  }

  async drain(groupKey: string): Promise<TakenRequest[]> {
    const state = await this.requests(groupKey);
    const all = [...state.live.values(), ...state.due.values()];
    state.live.clear();
    state.due.clear();
    this.remove(state, all);
    return all.map((entry) => this.taken(state, entry));
  }

  async takeDue(groupKey: string): Promise<TakenRequest[]> {
    const state = await this.requests(groupKey);
    const due = [...state.due.values()];
    state.due.clear();
    this.remove(state, due);
    return due.map((entry) => this.taken(state, entry));
  }

  /** The earliest live deadline of the group (for the `approvalDue` timer). */
  async earliest(groupKey: string): Promise<number | undefined> {
    const state = await this.requests(groupKey);
    let earliest: number | undefined;
    for (const entry of state.live.values()) {
      if (earliest === undefined || entry.d < earliest) earliest = entry.d;
    }
    return earliest;
  }

  releaseJoiner(requestId: string): Session | undefined {
    const session = this.joiners.get(requestId);
    if (session === undefined) return undefined;
    this.joiners.delete(requestId);
    if (session.pendingJoin?.requestId !== requestId) return undefined;
    session.pendingJoin = undefined;
    return session;
  }

  forgetJoiner(session: Session): void {
    const pending = session.pendingJoin;
    if (pending !== undefined && this.joiners.get(pending.requestId) === session) {
      this.joiners.delete(pending.requestId);
    }
    session.pendingJoin = undefined;
  }

  clearAll(): void {
    for (const session of this.joiners.values()) session.pendingJoin = undefined;
    this.joiners.clear();
  }
}

function parseRequest(raw: unknown): { i: string; n: string | undefined; d: number } | undefined {
  if (typeof raw !== 'string') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return { i: parsed.data.i, n: parsed.data.n, d: parsed.data.d };
}
