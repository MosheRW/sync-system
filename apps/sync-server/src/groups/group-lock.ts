import { AsyncLocalStorage } from 'node:async_hooks';
import { EffectOutbox } from './effects.js';
import { KeyedLock } from './keyed-lock.js';

/**
 * The storage side of one locked group task (#35 ADR 0011). The in-memory
 * store applies every call at once, so its commit has nothing to do; the
 * Redis store buffers the task's writes and commits them in one step.
 */
export interface UnitOfWork {
  /** Writes every buffered change at once, or nothing. */
  commit(): Promise<void>;
  /** The task failed or its commit failed: nothing buffered is written. */
  abandon(): Promise<void>;
}

export interface UnitOfWorkSource {
  /**
   * True when a task that throws leaves the stored state unchanged (Redis):
   * its effects are then dropped. False for the in-memory store, whose
   * calls already took effect: the effects are flushed as before.
   */
  readonly transactional: boolean;
  begin(namespace: string, groupId: string): UnitOfWork;
}

/** What a locked task can reach through `GroupLock.current()`. */
export interface GroupTask {
  readonly namespace: string;
  readonly groupId: string;
  readonly outbox: EffectOutbox;
  readonly work: UnitOfWork;
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
export class GroupLock {
  private readonly locks = new KeyedLock();

  constructor(
    private readonly source: UnitOfWorkSource = IMMEDIATE_WORK,
    private readonly onFailedCommit: (
      namespace: string,
      groupId: string,
      err: unknown,
    ) => void = () => undefined,
  ) {}

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
    return this.locks.run(groupKey(namespace, groupId), () =>
      this.runTask(namespace, groupId, task),
    );
  }

  private async runTask<T>(namespace: string, groupId: string, task: () => Promise<T>): Promise<T> {
    const outbox = new EffectOutbox();
    const work = this.source.begin(namespace, groupId);
    const state: GroupTask = { namespace, groupId, outbox, work };
    let result: T;
    try {
      result = await tasks.run(state, task);
    } catch (err) {
      if (this.source.transactional) {
        outbox.drop();
        await work.abandon();
        this.onFailedCommit(namespace, groupId, err);
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
      this.onFailedCommit(namespace, groupId, err);
      throw err;
    }
    outbox.flush();
    return result;
  }
}
