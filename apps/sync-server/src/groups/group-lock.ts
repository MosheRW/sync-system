import { AsyncLocalStorage } from 'node:async_hooks';
import { EffectOutbox } from './effects.js';
import { KeyedLock } from './keyed-lock.js';

/**
 * The storage side of one locked group task (#35 ADR 0011). The in-memory
 * store applies every call at once, so its commit has nothing to do; the
 * Redis store buffers the task's writes and commits them in one step.
 */
export interface UnitOfWork {
  /**
   * Reads the task's own group before the task runs (Redis: document,
   * position and attachment registry in one round trip, #35 12.1 step 3).
   */
  preload?(): Promise<void>;
  /** Writes every buffered change at once, or nothing. */
  commit(): Promise<void>;
  /** The task failed or its commit failed: nothing buffered is written. */
  abandon(): Promise<void>;
}

/**
 * A group's lease across instances (#35 architecture 12.4): the holder's
 * random token in a Redis key. Every commit of the task checks it.
 */
export interface HeldLease {
  readonly key: string;
  readonly token: string;
  /** Set when a renewal found the lease gone or failed. */
  lost: boolean;
  /** Compare-and-delete; failures are ignored (the lease expires). */
  release(): Promise<void>;
}

/** Where group leases come from (Redis with several instances); memory has none. */
export interface LeaseSource {
  /**
   * Takes the group's lease, waiting up to the bound; throws
   * StorageBusyError after it, or InstanceFencedError when fenced.
   */
  acquire(namespace: string, groupId: string): Promise<HeldLease>;
}

export interface UnitOfWorkSource {
  /**
   * True when a task that throws leaves the stored state unchanged (Redis):
   * its effects are then dropped. False for the in-memory store, whose
   * calls already took effect: the effects are flushed as before.
   */
  readonly transactional: boolean;
  begin(namespace: string, groupId: string, lease?: HeldLease): UnitOfWork;
}

/** What a locked task can reach through `GroupLock.current()`. */
export interface GroupTask {
  readonly namespace: string;
  readonly groupId: string;
  readonly outbox: EffectOutbox;
  readonly work: UnitOfWork;
  /** Sessions this task attached or detached (closed too if its commit fails). */
  readonly sessions: Set<object>;
  /** The group's lease while this task holds it (several instances). */
  readonly lease?: HeldLease | undefined;
}

const NO_WORK: UnitOfWork = {
  commit: () => Promise.resolve(),
  abandon: () => Promise.resolve(),
};

/** The in-memory store: every call is already applied. */
export const IMMEDIATE_WORK: UnitOfWorkSource = {
  transactional: false,
  begin: () => NO_WORK,
};

/** One context for every lock in the process, so a store finds its own unit of work. */
const tasks = new AsyncLocalStorage<GroupTask>();

/** The locked group task this code runs in, if any (any GroupLock). */
export function currentGroupTask(): GroupTask | undefined {
  return tasks.getStore();
}

function groupKey(namespace: string, groupId: string): string {
  return `${namespace}:${groupId}`;
}

/**
 * The per-group lock with its unit of work and effect outbox (#35 ADR 0011).
 * A task runs alone for its group (KeyedLock), its store writes are
 * committed when it returns, and only then are its session effects
 * flushed, in order. A failed commit writes nothing and drops the effects;
 * `onFailedCommit` then closes the group's local sessions (ADR 0014).
 */
export interface GroupLockOptions {
  /** The group lease across instances (#35 architecture 12.4); memory has none. */
  leases?: LeaseSource | undefined;
  /**
   * The synchronous instance guard (#35 security C11): when it is true
   * after a commit, the task's local effects are dropped (the self-fence
   * closes those sessions anyway).
   */
  fenced?: (() => boolean) | undefined;
  /**
   * Runs after the task's group was read and before the task (#35 Gate 2
   * Q-B10): effects received for the group from earlier commits are
   * applied first.
   */
  beforeTask?: ((namespace: string, groupId: string) => void) | undefined;
}

export class GroupLock {
  private readonly locks = new KeyedLock();
  private readonly leases: LeaseSource | undefined;
  private readonly fenced: () => boolean;
  private readonly beforeTask: ((namespace: string, groupId: string) => void) | undefined;

  constructor(
    private readonly source: UnitOfWorkSource = IMMEDIATE_WORK,
    private readonly onFailedCommit: (
      namespace: string,
      groupId: string,
      err: unknown,
      sessions: ReadonlySet<object>,
    ) => void = () => undefined,
    options: GroupLockOptions = {},
  ) {
    this.leases = options.leases;
    this.fenced = options.fenced ?? (() => false);
    this.beforeTask = options.beforeTask;
  }

  /** Number of groups with a task running or waiting. For tests only. */
  get size(): number {
    return this.locks.size;
  }

  /** The locked task this code runs in, if any. */
  current(): GroupTask | undefined {
    return tasks.getStore();
  }

  /**
   * Queues `effect` in the running task's outbox, or runs it now outside a
   * task.
   */
  effect(effect: () => void): void {
    const task = this.current();
    if (task === undefined) effect();
    else task.outbox.add(effect);
  }

  run<T>(namespace: string, groupId: string, task: () => Promise<T>): Promise<T> {
    return this.locks.run(groupKey(namespace, groupId), async () => {
      // Inside the local queue, so only one task per group and instance
      // asks Redis for the lease (#35 architecture 12.4).
      let lease: HeldLease | undefined;
      try {
        lease = await this.leases?.acquire(namespace, groupId);
      } catch (err) {
        // Redis down while taking the lease: as for a failed commit, the
        // group's local sessions close (ADR 0014). Busy closes nobody here.
        this.onFailedCommit(namespace, groupId, err, new Set());
        throw err;
      }
      try {
        return await this.runTask(namespace, groupId, task, lease);
      } finally {
        await lease?.release();
      }
    });
  }

  /**
   * Runs `step` in the group's local queue only: no lease and no unit of
   * work (#35 architecture 12.7: effects received from another instance),
   * so it never interleaves with a local task of the same group.
   */
  runLocal<T>(namespace: string, groupId: string, step: () => T | Promise<T>): Promise<T> {
    return this.locks.run(groupKey(namespace, groupId), () => Promise.resolve(step()));
  }

  private async runTask<T>(
    namespace: string,
    groupId: string,
    task: () => Promise<T>,
    lease: HeldLease | undefined,
  ): Promise<T> {
    const outbox = new EffectOutbox();
    const work = this.source.begin(namespace, groupId, lease);
    const state: GroupTask = { namespace, groupId, outbox, work, sessions: new Set(), lease };
    let result: T;
    try {
      await work.preload?.();
      this.beforeTask?.(namespace, groupId);
      result = await tasks.run(state, task);
    } catch (err) {
      if (this.source.transactional) {
        outbox.drop();
        await work.abandon();
        this.onFailedCommit(namespace, groupId, err, state.sessions);
      } else {
        outbox.flush();
      }
      throw err;
    }
    try {
      await work.commit();
    } catch (err) {
      outbox.drop();
      await work.abandon();
      this.onFailedCommit(namespace, groupId, err, state.sessions);
      throw err;
    }
    // Security C11: a fenced instance shows nothing more to its sessions.
    if (this.fenced()) outbox.drop();
    else outbox.flush();
    return result;
  }
}
