import {
  ErrorCode,
  type GroupLockMessage,
  type GroupUnlockMessage,
  type ServerMessage,
  type ViceClearMessage,
  type ViceSetMessage,
} from '@sync-system/protocol';
import type { GroupPatch, GroupRecord } from '../groups/group-store.js';
import type { Membership, Session } from '../groups/session.js';
import {
  LEADER_CONTROL_WINDOW_MS,
  LOCK_CHANGES_PER_GROUP_PER_MINUTE,
  VICE_CHANGES_PER_GROUP_PER_MINUTE,
} from '../limits/constants.js';
import { SlidingWindowRateLimiter } from '../limits/rate-limiter.js';
import { type Logger, groupRef } from '../logging/logger.js';
import { actionErrorMessage, errorMessage } from '../ws/error-messages.js';
import type { LeaderAction } from './leader-guard.js';
import { find } from './roster.js';

/** What the leader controls need from GroupService (the facade). */
export interface LeaderControlsHost {
  /**
   * Runs `task` under the group lock after `authorizeLeader` passed against
   * the record read under it (#13 D1, RC1).
   */
  asLeader(
    session: Session,
    action: LeaderAction,
    task: (record: GroupRecord, membership: Membership) => Promise<ServerMessage>,
  ): Promise<ServerMessage>;
  /** Sets fields of the record in one step; returns the updated record. */
  patch(record: GroupRecord, patch: GroupPatch): Promise<GroupRecord>;
  /** The session attached as `pid` in the group, if any. */
  sessionOf(record: GroupRecord, pid: string): Session | undefined;
  /** Sends `message` to `session` after the replies it is already owed. */
  deliverLater(session: Session, message: ServerMessage): void;
  /** Tells the leader one roster entry changed (#13 AC31). */
  rosterUpdated(record: GroupRecord, pid: string): void;
  /** Sends `message` to every attached member (not the leader). */
  toMembers(record: GroupRecord, message: ServerMessage): void;
  now(): number;
}

/** One frozen answer for every target that is not on this group's roster (#13 AC10, AC44). */
const PARTICIPANT_NOT_FOUND = Object.freeze(errorMessage(ErrorCode.PARTICIPANT_NOT_FOUND));

function groupKey(record: GroupRecord): string {
  return `${record.appNamespace}:${record.id}`;
}

/**
 * The leader's group controls (#13 3.1). Every handler follows one order
 * under the group lock (6.8, RC1, RC2): (1) authorization, (2) input and
 * state checks, (3) the per-group limiter keyed by namespace and group,
 * (4) the effect. A request refused at (1) or (2) never spends budget.
 */
export class LeaderControls {
  /** vice.set / vice.clear per group (#13 8.2). */
  private readonly viceLimiter: SlidingWindowRateLimiter;
  /** group.lock / group.unlock per group (#13 8.2). */
  private readonly lockLimiter: SlidingWindowRateLimiter;

  constructor(
    private readonly host: LeaderControlsHost,
    private readonly logger: Logger,
  ) {
    const now = (): number => host.now();
    this.viceLimiter = new SlidingWindowRateLimiter(now, LEADER_CONTROL_WINDOW_MS);
    this.lockLimiter = new SlidingWindowRateLimiter(now, LEADER_CONTROL_WINDOW_MS);
  }

  /**
   * group.lock / group.unlock (#13 AC29): idempotent. A change is broadcast
   * to the members; a request that changes nothing is only answered. The
   * lock is independent of the door-code pause (#10 AC29).
   */
  setLock(
    session: Session,
    message: GroupLockMessage | GroupUnlockMessage,
  ): Promise<ServerMessage> {
    const locked = message.type === 'group.lock';
    return this.host.asLeader(session, message.type, async (record) => {
      const rate = this.lockLimiter.tryAcquire(groupKey(record), LOCK_CHANGES_PER_GROUP_PER_MINUTE);
      if (!rate.ok) {
        return actionErrorMessage(ErrorCode.RATE_LIMITED, message.type, {
          details: { retryAfterMs: rate.retryAfterMs },
        });
      }
      if (record.locked !== locked) {
        const updated = await this.host.patch(record, { locked });
        this.host.toMembers(updated, { type: 'lock.changed', groupId: updated.id, locked });
        this.logger.info(
          {
            event: locked ? 'group_locked' : 'group_unlocked',
            namespace: record.appNamespace,
            groupRef: groupRef(record.id),
          },
          locked ? 'group locked' : 'group unlocked',
        );
      }
      return { type: 'lock.changed', groupId: record.id, locked };
    });
  }

  /**
   * vice.set (#13 AC10, Q3.4): the target must be on the roster, connected,
   * not the leader and not blocked. One vice at most: a new one replaces the
   * old one. Only the old and the new vice are told (Q3.3).
   */
  setVice(session: Session, message: ViceSetMessage): Promise<ServerMessage> {
    return this.host.asLeader(session, 'vice.set', async (record) => {
      const target = message.participantId;
      const entry = find(record.roster, target);
      if (entry === undefined || record.blockList.includes(target)) return PARTICIPANT_NOT_FOUND;
      if (target === record.leaderId || !entry.connected) {
        return actionErrorMessage(ErrorCode.NOT_ALLOWED, 'vice.set');
      }
      const limited = this.spend(this.viceLimiter, record, 'vice.set');
      if (limited !== undefined) return limited;
      const updated = await this.applyVice(record, target);
      return { type: 'vice.updated', groupId: updated.id, viceId: target };
    });
  }

  /** vice.clear (#13 AC10). Idempotent. */
  clearVice(session: Session, _message: ViceClearMessage): Promise<ServerMessage> {
    return this.host.asLeader(session, 'vice.clear', async (record) => {
      const limited = this.spend(this.viceLimiter, record, 'vice.clear');
      if (limited !== undefined) return limited;
      const updated = await this.applyVice(record, undefined);
      return { type: 'vice.updated', groupId: updated.id, viceId: null };
    });
  }

  /**
   * Sets or clears the vice-leader and tells the old and the new one, and
   * the leader through the roster. Also used when a vice leaves, is removed
   * or becomes leader (#13 AC12). Runs under the group lock.
   */
  async applyVice(record: GroupRecord, viceId: string | undefined): Promise<GroupRecord> {
    const previous = record.viceId;
    if (previous === viceId) return record;
    const updated = await this.host.patch(record, { viceId });
    if (previous !== undefined) {
      this.tellVice(updated, previous, false);
      this.host.rosterUpdated(updated, previous);
    }
    if (viceId !== undefined) {
      this.tellVice(updated, viceId, true);
      this.host.rosterUpdated(updated, viceId);
    }
    this.logger.info(
      { event: 'vice_changed', namespace: record.appNamespace, groupRef: groupRef(record.id) },
      'vice-leader changed',
    );
    return updated;
  }

  /** `vice.changed` to `pid` if it is attached (#13 AC11). */
  tellVice(record: GroupRecord, pid: string, isVice: boolean): void {
    const session = this.host.sessionOf(record, pid);
    if (session === undefined) return;
    this.host.deliverLater(session, { type: 'vice.changed', groupId: record.id, isVice });
  }

  /** Charges one event of `limiter` for the group, or answers RATE_LIMITED. */
  private spend(
    limiter: SlidingWindowRateLimiter,
    record: GroupRecord,
    action: 'vice.set' | 'vice.clear',
  ): ServerMessage | undefined {
    const rate = limiter.tryAcquire(groupKey(record), VICE_CHANGES_PER_GROUP_PER_MINUTE);
    if (rate.ok) return undefined;
    return actionErrorMessage(ErrorCode.RATE_LIMITED, action, {
      details: { retryAfterMs: rate.retryAfterMs },
    });
  }

  /** The group ended: its budgets go (#13 RC2). */
  forgetGroup(namespace: string, groupId: string): void {
    this.viceLimiter.forget(`${namespace}:${groupId}`);
    this.lockLimiter.forget(`${namespace}:${groupId}`);
  }

  /** Server shutdown (#13 RC2). */
  close(): void {
    this.viceLimiter.clear();
    this.lockLimiter.clear();
  }

  /** Number of tracked limiter keys. For tests only. */
  get limiterSize(): number {
    return this.viceLimiter.size + this.lockLimiter.size;
  }
}
