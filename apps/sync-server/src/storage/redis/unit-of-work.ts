import type { GroupRecord } from '../../groups/group-store.js';
import {
  type UnitOfWork,
  type UnitOfWorkSource,
  currentGroupTask,
} from '../../groups/group-lock.js';
import { InMemoryGroupStore } from '../../groups/in-memory-group-store.js';
import { KeyedLock } from '../../groups/keyed-lock.js';
import { endedRef } from '../../groups/ended-groups.js';
import { MAX_CLOCK_SKEW_MS } from '../../limits/constants.js';
import type { DoorState } from '../../joins/door-guard.js';
import type { Logger } from '../../logging/logger.js';
import { InstanceFencedError, StorageConflictError, StorageInvalidError } from '../errors.js';
import type { RedisLink } from './connect.js';
import { decodeGroup, encodeDocument, encodePosition } from './document.js';
import type { RedisKeys } from './keys.js';
import { COMMIT } from './scripts.js';

/** What every Redis part shares. */
export interface RedisContext {
  readonly link: RedisLink;
  readonly keys: RedisKeys;
  readonly logger: Logger;
  /** The group's end bound E: max-session deadline + slack (#35 AC24). */
  expiryOf(namespace: string, createdAt: number): number;
  now(): number;
  /**
   * With several instances (#35 security C11): the liveness key of this
   * instance, which every group-scoped commit requires, and what to do when
   * a commit found it gone. Unset in tests that use no instance.
   */
  instanceKey?: () => string | undefined;
  onFencedAbort?: () => void;
}

/** The instance fence of a commit plan (#35 security C11). */
export interface PlanFence {
  /** The liveness key that must exist. */
  key: string;
  /** Called when it did not (the instance fences itself). */
  onAbort?: (() => void) | undefined;
}

/** The fence for a commit of this instance now, if it runs with instances. */
export function fenceOf(ctx: RedisContext): PlanFence | undefined {
  const key = ctx.instanceKey?.();
  return key === undefined ? undefined : { key, onAbort: ctx.onFencedAbort };
}

type Op = Record<string, string | number>;

/** What the ended-group writes of a commit evicted (#13 6.9 layer 3). */
export interface CommitResult {
  evicted: number;
  closed: string[];
}

/**
 * The checks and writes of one commit, for the COMMIT script. Expiry times
 * are given in the server's clock and sent as time-to-live from `now`.
 */
export class CommitPlan {
  readonly keys: string[] = [];

  constructor(
    private readonly now: number,
    private readonly fence?: PlanFence,
  ) {}

  /** Time to live in ms, at least 1 (a passed end makes the key vanish at once). */
  private ttl(expiresAt: number): string {
    return String(Math.max(1, Math.ceil(expiresAt - this.now)));
  }

  private readonly index = new Map<string, number>();
  private readonly checks: Op[] = [];
  private readonly writes: Op[] = [];

  get empty(): boolean {
    return this.checks.length === 0 && this.writes.length === 0;
  }

  private k(key: string): number {
    let i = this.index.get(key);
    if (i === undefined) {
      this.keys.push(key);
      i = this.keys.length;
      this.index.set(key, i);
    }
    return i;
  }

  absent(key: string, reason: string): void {
    this.checks.push({ o: 'absent', k: this.k(key), r: reason });
  }

  eq(key: string, value: string, reason: string): void {
    this.checks.push({ o: 'eq', k: this.k(key), v: value, r: reason });
  }

  set(key: string, value: string, expiresAt: number): void {
    this.writes.push({ o: 'set', k: this.k(key), v: value, x: this.ttl(expiresAt) });
  }

  setnx(key: string, value: string): void {
    this.writes.push({ o: 'setnx', k: this.k(key), v: value });
  }

  del(key: string): void {
    this.writes.push({ o: 'del', k: this.k(key) });
  }

  deleq(key: string, value: string): void {
    this.writes.push({ o: 'deleq', k: this.k(key), v: value });
  }

  hset(key: string, field: string, value: string): void {
    this.writes.push({ o: 'hset', k: this.k(key), f: field, v: value });
  }

  hdel(key: string, field: string): void {
    this.writes.push({ o: 'hdel', k: this.k(key), f: field });
  }

  zadd(key: string, score: number, member: string): void {
    this.writes.push({ o: 'zadd', k: this.k(key), s: String(score), m: member });
  }

  zrem(key: string, member: string): void {
    this.writes.push({ o: 'zrem', k: this.k(key), m: member });
  }

  zremif(key: string, member: string, score: number): void {
    this.writes.push({ o: 'zremif', k: this.k(key), m: member, s: String(score) });
  }

  /** A fired timer is done, unless it was armed again or claimed anew. */
  consume(due: string, member: string, lease: number, hash: string, field: string): void {
    this.writes.push({
      o: 'consume',
      k: this.k(due),
      m: member,
      s: String(lease),
      h: this.k(hash),
      f: field,
    });
  }

  keep(key: string, expiresAt: number): void {
    this.writes.push({ o: 'keep', k: this.k(key), x: this.ttl(expiresAt) });
  }

  extend(key: string, expiresAt: number): void {
    this.writes.push({ o: 'extend', k: this.k(key), x: this.ttl(expiresAt) });
  }

  /** Any other write op of the COMMIT script (`remember`). */
  raw(op: string, keys: Record<string, string>, values: Record<string, string>): void {
    const entry: Op = { o: op };
    for (const [name, key] of Object.entries(keys)) entry[name] = this.k(key);
    Object.assign(entry, values);
    this.writes.push(entry);
  }

  /**
   * Runs the commit; throws StorageConflictError when a check failed.
   * Returns what `remember` did (evictions, closed namespaces).
   */
  async run(link: RedisLink): Promise<CommitResult> {
    if (this.empty) return { evicted: 0, closed: [] };
    // Security C11: a fenced instance never writes; this check comes first.
    const checks =
      this.fence === undefined
        ? this.checks
        : [{ o: 'exists', k: this.k(this.fence.key), r: 'fenced' }, ...this.checks];
    const reply = await link.script(COMMIT, this.keys, [
      JSON.stringify({ c: checks, w: this.writes }),
    ]);
    if (Array.isArray(reply) && reply[0] === 'abort') {
      if (reply[1] === 'fenced') {
        this.fence?.onAbort?.();
        throw new InstanceFencedError();
      }
      throw new StorageConflictError(String(reply[1]));
    }
    const [, evicted, closed] = Array.isArray(reply) ? (reply as unknown[]) : [];
    const count = Number(evicted);
    return {
      evicted: Number.isSafeInteger(count) && count > 0 ? count : 0,
      closed: typeof closed === 'string' && closed !== '' ? closed.split(',') : [],
    };
  }
}

/** The groups of a commit as the steps see them. */
export interface PlanGroups {
  /** The group's end bound E if it is stored after this commit, else undefined. */
  expiry(namespace: string, groupId: string): number | undefined;
}

/** One group as the unit of work knows it. */
export interface WorkEntry {
  readonly namespace: string;
  readonly groupId: string;
  /** The texts as loaded, to write only what changed. */
  docText: string | undefined;
  posText: string | undefined;
  existed: boolean;
  /** Set by create (`create`) or a recreation (`ifAbsent`). */
  mode: 'create' | 'ifAbsent' | undefined;
  deleted: boolean;
  /** Door state (#10 AC29), stored in the document (#35 AC7). */
  door: DoorState | undefined;
}

function keyOf(namespace: string, groupId: string): string {
  return `${namespace}:${groupId}`;
}

/**
 * One locked task's view of Redis (#35 ADR 0011). Each group is read once
 * into a task-scoped `InMemoryGroupStore` (the same record logic as the
 * memory store), every store call applies there, and `commit` writes the
 * changes, plus whatever the other parts added, in one COMMIT script. A
 * failed or skipped commit writes nothing.
 */
export class RedisUnitOfWork implements UnitOfWork {
  readonly cache = new InMemoryGroupStore();
  private readonly entries = new Map<string, WorkEntry>();
  private readonly loading = new Map<string, Promise<WorkEntry>>();
  private readonly steps: Array<(plan: CommitPlan, groups: PlanGroups) => void> = [];
  private readonly abandoned: Array<() => Promise<void>> = [];
  private readonly committed: Array<(result: CommitResult) => void> = [];
  /** The epoch this task classified tokens with (re-checked by a recreation, C7). */
  private epochSeen: string | undefined;
  /** The instance this task started as (security C11): its commit requires that liveness. */
  private readonly fence: PlanFence | undefined;

  constructor(readonly ctx: RedisContext) {
    this.fence = fenceOf(ctx);
  }

  /** The group's entry, read from Redis on first use. */
  entry(namespace: string, groupId: string): Promise<WorkEntry> {
    const key = keyOf(namespace, groupId);
    const known = this.entries.get(key);
    if (known !== undefined) return Promise.resolve(known);
    let pending = this.loading.get(key);
    if (pending === undefined) {
      pending = this.load(namespace, groupId);
      this.loading.set(key, pending);
    }
    return pending;
  }

  private async load(namespace: string, groupId: string): Promise<WorkEntry> {
    const stored = await readGroup(this.ctx, namespace, groupId);
    const entry: WorkEntry = {
      namespace,
      groupId,
      docText: stored?.docText,
      posText: stored?.posText,
      existed: stored !== undefined,
      mode: undefined,
      deleted: false,
      door: stored?.door,
    };
    if (stored !== undefined) await this.cache.create(stored.record);
    this.entries.set(keyOf(namespace, groupId), entry);
    this.loading.delete(keyOf(namespace, groupId));
    return entry;
  }

  /** A new group (`create`) or a recreation (`ifAbsent`, re-checked at commit, C7). */
  async create(group: GroupRecord, mode: 'create' | 'ifAbsent'): Promise<void> {
    const entry = await this.entry(group.appNamespace, group.id);
    entry.mode = mode;
    entry.deleted = false;
    await this.cache.create(group);
  }

  async remove(namespace: string, groupId: string): Promise<void> {
    const entry = await this.entry(namespace, groupId);
    entry.deleted = true;
    entry.door = undefined;
    await this.cache.delete(namespace, groupId);
  }

  /** Adds writes to this commit (codes, timers, ended groups), in call order. */
  addStep(step: (plan: CommitPlan, groups: PlanGroups) => void): void {
    this.steps.push(step);
  }

  /** Records the epoch value read in this task. */
  seeEpoch(raw: string): void {
    this.epochSeen = raw;
  }

  /** Runs `then` with the commit's result once it succeeded. */
  afterCommit(then: (result: CommitResult) => void): void {
    this.committed.push(then);
  }

  /** Runs `undo` if the task fails or its commit fails (release claims, best effort). */
  onAbandon(undo: () => Promise<void>): void {
    this.abandoned.push(undo);
  }

  /** The commit plan of this task. */
  async plan(): Promise<CommitPlan> {
    const plan = new CommitPlan(this.ctx.now(), this.fence);
    const { keys } = this.ctx;
    const ends = new Map<string, number>();
    for (const entry of this.entries.values()) {
      const { namespace, groupId } = entry;
      const docKey = keys.group(namespace, groupId);
      const posKey = keys.position(namespace, groupId);
      const record = await this.cache.get(namespace, groupId);
      if (entry.deleted || record === undefined) {
        if (!entry.existed) continue;
        plan.del(docKey);
        plan.del(posKey);
        plan.zrem(keys.live(), keys.liveMember(namespace, groupId));
        continue;
      }
      const expiresAt = this.ctx.expiryOf(namespace, record.createdAt);
      ends.set(keyOf(namespace, groupId), expiresAt);
      const doc = encodeDocument(record, entry.door);
      const pos = encodePosition(record);
      if (entry.mode !== undefined) plan.absent(docKey, 'exists');
      if (entry.mode === 'ifAbsent') {
        // Security C7: the recreation stands only if the group did not end
        // and the epoch it was classified with is still the epoch.
        plan.absent(keys.ended(endedRef(namespace, groupId)), 'ended');
        // No epoch read in this task: nothing to re-check, so fail closed.
        if (this.epochSeen === undefined) throw new StorageConflictError('epoch');
        plan.eq(keys.epoch(), this.epochSeen, 'epoch');
      }
      // Tokens issued right after a flush are never older than the epoch (C7).
      if (entry.mode === 'create') plan.setnx(keys.epoch(), String(this.ctx.now()));
      if (entry.mode !== undefined || doc !== entry.docText) {
        plan.set(docKey, doc, expiresAt);
        plan.zadd(keys.live(), expiresAt, keys.liveMember(namespace, groupId));
        plan.extend(keys.live(), expiresAt);
        // The epoch outlives every group and ended entry, then goes (F12).
        plan.extend(keys.epoch(), expiresAt + MAX_CLOCK_SKEW_MS);
      }
      if (entry.mode !== undefined || pos !== entry.posText) plan.set(posKey, pos, expiresAt);
    }
    const groups: PlanGroups = {
      expiry: (namespace, groupId) => ends.get(keyOf(namespace, groupId)),
    };
    for (const step of this.steps) step(plan, groups);
    return plan;
  }

  async commit(): Promise<void> {
    const plan = await this.plan();
    const result = await plan.run(this.ctx.link);
    for (const then of this.committed) then(result);
  }

  async abandon(): Promise<void> {
    for (const undo of this.abandoned.splice(0)) {
      try {
        await undo();
      } catch {
        // Best effort: a claim left behind expires with its TTL.
      }
    }
  }

  /** Every group this work touched (for the failed-commit closes). */
  groups(): WorkEntry[] {
    return [...this.entries.values()];
  }
}

/** A group as stored: the record, its door state and the raw texts. */
export interface StoredGroupTexts {
  record: GroupRecord;
  door: DoorState | undefined;
  docText: string;
  posText: string;
}

/**
 * Reads a group (document and position in one MGET). Undefined when the
 * document is missing; StorageInvalidError when it fails its schema
 * (logged without key or content; never treated as missing, security C1).
 */
export async function readGroup(
  ctx: RedisContext,
  namespace: string,
  groupId: string,
): Promise<StoredGroupTexts | undefined> {
  const { keys } = ctx;
  const reply = await ctx.link.send([
    'MGET',
    keys.group(namespace, groupId),
    keys.position(namespace, groupId),
  ]);
  const [docText, posText] = Array.isArray(reply) ? (reply as unknown[]) : [];
  if (docText === null || docText === undefined) return undefined;
  const decoded =
    typeof docText === 'string' && (typeof posText === 'string' || posText === null)
      ? decodeGroup(namespace, groupId, docText, posText ?? undefined)
      : 'invalid';
  if (decoded === 'invalid') {
    ctx.logger.error({ event: 'store_document_invalid' }, 'stored group document is invalid');
    throw new StorageInvalidError();
  }
  return { ...decoded, docText: docText as string, posText: posText as string };
}

/**
 * The unit-of-work source of the Redis storage: a fresh work per locked
 * task; failures leave Redis unchanged, so effects are dropped.
 */
export class RedisWorkSource implements UnitOfWorkSource {
  readonly transactional = true;
  /** Serializes one-step works per group, so each is atomic in this process. */
  private readonly standalone = new KeyedLock();

  constructor(private readonly ctx: RedisContext) {}

  begin(): RedisUnitOfWork {
    return new RedisUnitOfWork(this.ctx);
  }

  /**
   * An empty commit plan, for a step outside any unit of work. Fenced by
   * this instance's liveness (security C11) unless `fenced` is false (only
   * compare-and-delete code releases).
   */
  plan(fenced = true): CommitPlan {
    return new CommitPlan(this.ctx.now(), fenced ? fenceOf(this.ctx) : undefined);
  }

  /** The running task's work if it belongs to this storage. */
  current(): RedisUnitOfWork | undefined {
    const work = currentGroupTask()?.work;
    return work instanceof RedisUnitOfWork && work.ctx === this.ctx ? work : undefined;
  }

  /**
   * Runs `step` in the running task's work, or in a one-step work that
   * commits at once (calls outside a group task: tests, direct use).
   */
  async within<T>(
    namespace: string,
    groupId: string,
    step: (work: RedisUnitOfWork) => Promise<T>,
  ): Promise<T> {
    const running = this.current();
    if (running !== undefined) return step(running);
    return this.standalone.run(`${namespace}:${groupId}`, async () => {
      const work = this.begin();
      let result: T;
      try {
        result = await step(work);
        await work.commit();
      } catch (err) {
        await work.abandon();
        throw err;
      }
      return result;
    });
  }
}
