import type { Session } from '../groups/session.js';
import { ApprovalQueue, type PendingRequest, type TakenRequest } from './approval-queue.js';
import type { Scheduler } from '../time/scheduler.js';

export type { PendingRequest, TakenRequest } from './approval-queue.js';

/**
 * Pending method B join requests (#10 AC19-AC22, #35 AC7, AC20). Every
 * method runs under the group's lock; every way a request ends removes it
 * first, so it settles exactly once (R11). In memory by default; with
 * several instances the requests live in Redis (#35 architecture 12.9).
 */
export interface ApprovalStore {
  /**
   * Adds a request for `request.session` with its deadline, or `'full'`
   * when the group already has the most pending. `onTimeout` runs at the
   * deadline (memory; Redis uses the `approvalDue` timer instead).
   */
  add(
    request: Omit<PendingRequest, 'requestId'>,
    onTimeout: (requestId: string) => void,
  ): Promise<PendingRequest | 'full'>;
  /** Removes and returns a request of this group only (R11), or undefined. */
  take(groupKey: string, requestId: string): Promise<TakenRequest | undefined>;
  /** Removes and returns the session's pending request, or undefined. */
  takeBySession(session: Session): Promise<TakenRequest | undefined>;
  /** The group's pending requests, oldest first (not removed). */
  list(groupKey: string): Promise<PendingRequest[]>;
  /** Removes and returns every pending request of the group (group end or drop). */
  drain(groupKey: string): Promise<TakenRequest[]>;
  /** Server shutdown: every local timer and joiner reference goes (AC31). */
  clearAll(): void;
  /** Number of pending requests known here. For tests only. */
  readonly size: number;
}

/** The in-memory store: today's `ApprovalQueue`, with its exact per-request timers. */
export class MemoryApprovals implements ApprovalStore {
  private readonly queue: ApprovalQueue;

  constructor(scheduler: Scheduler) {
    this.queue = new ApprovalQueue(scheduler);
  }

  get size(): number {
    return this.queue.size;
  }

  add(
    request: Omit<PendingRequest, 'requestId'>,
    onTimeout: (requestId: string) => void,
  ): Promise<PendingRequest | 'full'> {
    return Promise.resolve(this.queue.add(request, onTimeout));
  }

  take(groupKey: string, requestId: string): Promise<TakenRequest | undefined> {
    return Promise.resolve(this.queue.take(groupKey, requestId));
  }

  takeBySession(session: Session): Promise<TakenRequest | undefined> {
    return Promise.resolve(this.queue.takeBySession(session));
  }

  list(groupKey: string): Promise<PendingRequest[]> {
    return Promise.resolve(this.queue.list(groupKey));
  }

  drain(groupKey: string): Promise<TakenRequest[]> {
    return Promise.resolve(this.queue.drain(groupKey));
  }

  clearAll(): void {
    this.queue.clearAll();
  }
}
