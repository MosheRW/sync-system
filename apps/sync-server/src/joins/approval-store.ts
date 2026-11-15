import type { Session } from '../groups/session.js';
import { ApprovalQueue } from './approval-queue.js';
import type { Scheduler } from '../time/scheduler.js';

/** A method B join request waiting for the leader (#10 AC19-AC22, #35 AC7). */
export interface PendingRequest {
  /** 16 CSPRNG bytes, base64url (22 characters). Never logged. */
  readonly requestId: string;
  readonly groupKey: string;
  readonly groupId: string;
  /** Validated display name; relayed to the leader only, dropped on settle (AC20). */
  readonly displayName: string | undefined;
  /** Epoch ms when the request times out. */
  readonly deadline: number;
}

/** A settled request, removed from the store by the caller that got it (R11). */
export interface TakenRequest extends PendingRequest {
  /** The joiner's session when it waits on this instance. */
  readonly session: Session | undefined;
  /** True when the joiner's session still pointed at this request when it was taken. */
  readonly current: boolean;
  /** With several instances: the instance the joiner waits on, when not this one. */
  readonly instance?: string | undefined;
}

/** What `add` needs: the request and the joiner's session. */
export interface NewRequest {
  readonly groupKey: string;
  readonly groupId: string;
  readonly session: Session;
  readonly displayName: string | undefined;
  readonly deadline: number;
}

/**
 * Pending method B join requests (#10 AC19-AC22, #35 AC7, AC20). Every
 * method runs under the group's lock; every way a request ends removes it
 * first, so it settles exactly once (R11). In memory by default; with
 * Redis the requests live in Redis and the joiner's state stays on its
 * instance (#35 architecture 12.9).
 */
export interface ApprovalStore {
  /**
   * True when the store times requests out itself (memory: one timer per
   * request). False with Redis: the `approvalDue` group timer does it.
   */
  readonly timed: boolean;
  /**
   * Adds a request for `request.session` with its deadline, or `'full'`
   * when the group already has the most pending. `onTimeout` runs at the
   * deadline (memory only).
   */
  add(
    request: NewRequest,
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
  /** Removes and returns the requests whose deadline passed (Redis; memory: none). */
  takeDue(groupKey: string): Promise<TakenRequest[]>;
  /** The group's earliest pending deadline (Redis: the `approvalDue` timer). */
  earliest?(groupKey: string): Promise<number | undefined>;
  /**
   * The local session waiting on `requestId` (several instances: a joiner
   * here whose request another instance decided), and stops tracking it.
   */
  releaseJoiner(requestId: string): Session | undefined;
  /** The session stops waiting here without touching the stored request. */
  forgetJoiner(session: Session): void;
  /** Server shutdown: every local timer and joiner reference goes (AC31). */
  clearAll(): void;
  /** Number of pending requests known here. For tests only. */
  readonly size: number;
}

/** The in-memory store: today's `ApprovalQueue`, with its exact per-request timers. */
export class MemoryApprovals implements ApprovalStore {
  readonly timed = true;
  private readonly queue: ApprovalQueue;

  constructor(scheduler: Scheduler) {
    this.queue = new ApprovalQueue(scheduler);
  }

  get size(): number {
    return this.queue.size;
  }

  add(
    request: NewRequest,
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

  takeDue(): Promise<TakenRequest[]> {
    return Promise.resolve([]);
  }

  releaseJoiner(): Session | undefined {
    return undefined;
  }

  forgetJoiner(session: Session): void {
    void this.queue.takeBySession(session);
  }

  clearAll(): void {
    this.queue.clearAll();
  }
}
