import { randomBytes } from 'node:crypto';
import { MAX_PENDING_APPROVALS_PER_GROUP } from '../limits/constants.js';
import type { Session } from '../groups/session.js';
import type { Cancel, Scheduler } from '../time/scheduler.js';

/** A method B join request waiting for the leader (#10 AC19-AC22). */
export interface PendingRequest {
  /** 16 CSPRNG bytes, base64url (22 characters). Never logged. */
  readonly requestId: string;
  readonly groupKey: string;
  readonly groupId: string;
  readonly session: Session;
  /** Validated display name; relayed to the leader only, dropped on settle (AC20). */
  readonly displayName: string | undefined;
  /** Epoch ms when the request times out. */
  readonly deadline: number;
}

interface Entry extends PendingRequest {
  cancel: Cancel;
}

/** A settled request, removed from the queue by the caller that got it (R11). */
export interface TakenRequest extends PendingRequest {
  /** True when the joiner's session still pointed at this request when it was taken. */
  readonly current: boolean;
}

/** A new request ID: 16 bytes from the CSPRNG (#10 R11). */
export function newRequestId(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Pending method B requests per group, in memory only (#10 AC22, Q6.3).
 * At most MAX_PENDING_APPROVALS_PER_GROUP per group; one per session
 * (`session.pendingJoin`). Every way a request ends removes it first
 * (`take`, `takeBySession`, `drain`), clearing the session's back-pointer
 * and the deadline timer in the same synchronous step, so the first caller
 * wins and every later caller finds nothing (R11). Callers hold the group's
 * lock.
 */
export class ApprovalQueue {
  private readonly groups = new Map<string, Map<string, Entry>>();

  constructor(private readonly scheduler: Scheduler) {}

  /**
   * Adds a request for `session`, with its deadline timer, or `'full'`
   * when the group already has the maximum pending.
   */
  add(
    request: Omit<PendingRequest, 'requestId'>,
    onTimeout: (requestId: string) => void,
  ): PendingRequest | 'full' {
    let queue = this.groups.get(request.groupKey);
    if (queue === undefined) {
      queue = new Map();
      this.groups.set(request.groupKey, queue);
    }
    if (queue.size >= MAX_PENDING_APPROVALS_PER_GROUP) return 'full';
    let requestId = newRequestId();
    while (queue.has(requestId)) requestId = newRequestId();
    const entry: Entry = {
      ...request,
      requestId,
      cancel: this.scheduler.at(request.deadline, () => onTimeout(requestId)),
    };
    queue.set(requestId, entry);
    request.session.pendingJoin = {
      groupKey: request.groupKey,
      groupId: request.groupId,
      requestId,
    };
    return entry;
  }

  private remove(entry: Entry): TakenRequest {
    entry.cancel();
    const queue = this.groups.get(entry.groupKey);
    queue?.delete(entry.requestId);
    if (queue?.size === 0) this.groups.delete(entry.groupKey);
    const current = entry.session.pendingJoin?.requestId === entry.requestId;
    if (current) entry.session.pendingJoin = undefined;
    return {
      requestId: entry.requestId,
      groupKey: entry.groupKey,
      groupId: entry.groupId,
      session: entry.session,
      displayName: entry.displayName,
      deadline: entry.deadline,
      current,
    };
  }

  /** Removes and returns a request of this group only (R11), or undefined. */
  take(groupKey: string, requestId: string): TakenRequest | undefined {
    const entry = this.groups.get(groupKey)?.get(requestId);
    return entry === undefined ? undefined : this.remove(entry);
  }

  /** Removes and returns the session's pending request, or undefined. */
  takeBySession(session: Session): TakenRequest | undefined {
    const pending = session.pendingJoin;
    if (pending === undefined) return undefined;
    const entry = this.groups.get(pending.groupKey)?.get(pending.requestId);
    if (entry === undefined || entry.session !== session) {
      session.pendingJoin = undefined;
      return undefined;
    }
    return this.remove(entry);
  }

  /** The group's pending requests, oldest first (not removed). */
  list(groupKey: string): PendingRequest[] {
    return [...(this.groups.get(groupKey)?.values() ?? [])];
  }

  /** Removes and returns every pending request of the group (group end or drop). */
  drain(groupKey: string): TakenRequest[] {
    return [...(this.groups.get(groupKey)?.values() ?? [])].map((entry) => this.remove(entry));
  }

  /** Server shutdown: every timer is cancelled (AC31). */
  clearAll(): void {
    for (const queue of this.groups.values()) {
      for (const entry of queue.values()) this.remove(entry);
    }
    this.groups.clear();
  }

  /** Number of pending requests in every group. For tests only. */
  get size(): number {
    let total = 0;
    for (const queue of this.groups.values()) total += queue.size;
    return total;
  }
}
