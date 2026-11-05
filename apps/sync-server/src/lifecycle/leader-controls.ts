import {
  ErrorCode,
  MAX_BLOCK_LIST_SIZE,
  type GroupLockMessage,
  type GroupUnlockMessage,
  type ErrorMessage,
  type KeepAliveAckMessage,
  type LeaderActivityMessage,
  type LeaderTakeBackMessage,
  type JoinCodesPayload,
  type MemberRemoveMessage,
  type ServerMessage,
  type ViceClearMessage,
  type ViceSetMessage,
} from '@sync-system/protocol';
import type { GroupPatch, GroupRecord } from '../groups/group-store.js';
import type { Membership, Session } from '../groups/session.js';
import type { AppConfig } from '../apps/app-registry.js';
import type { GroupCodes } from '../joins/codes.js';
import {
  LEADER_ACTIVITY_PER_GROUP_PER_MINUTE,
  LEADER_CONTROL_WINDOW_MS,
  LOCK_CHANGES_PER_GROUP_PER_MINUTE,
  MEMBER_REMOVALS_PER_GROUP_PER_MINUTE,
  TAKE_BACKS_PER_GROUP_PER_MINUTE,
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
  /**
   * Adds `pids` to the block list (union, BLOCK_LIST_FULL past 256) and
   * removes them: detach, roster, vice (#13 D5, D6). Undefined or the error.
   */
  block(
    app: AppConfig,
    record: GroupRecord,
    pids: readonly string[],
  ): Promise<ErrorMessage | undefined>;
  /** Claims a full new code set (codes and QR ticket generation). */
  claimFullSet(record: GroupRecord): GroupCodes | 'exhausted';
  /** Stores a claimed set and frees the old codes. */
  commitFullSet(
    record: GroupRecord,
    next: GroupCodes,
    leader: Session | undefined,
  ): Promise<GroupRecord | undefined>;
  /** Releases a claimed set that was not committed. */
  releaseClaim(record: GroupRecord, claimed: GroupCodes): void;
  /** The leader-only codes payload. */
  codesPayload(record: GroupRecord): JoinCodesPayload;
  /** Re-reads the record. */
  get(record: GroupRecord): Promise<GroupRecord | undefined>;
  /**
   * Runs `task` under the lock of the session's group with the record and
   * the owned membership, without the leader check (take-back).
   */
  asMember(
    session: Session,
    task: (record: GroupRecord, membership: Membership) => Promise<ServerMessage>,
  ): Promise<ServerMessage>;
  /** Swaps the lead to the requester (6.6 take-back); returns `leader.granted`. */
  takeBackFor(session: Session, record: GroupRecord, pid: string): Promise<ServerMessage>;
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
  /** member.remove per group (#13 8.2). */
  private readonly removeLimiter: SlidingWindowRateLimiter;
  /** leader.activity and keepalive.ack per group, shared (#13 8.2). */
  private readonly activityLimiter: SlidingWindowRateLimiter;
  /** leader.takeBack per group (#13 8.2). */
  private readonly takeBackLimiter: SlidingWindowRateLimiter;

  constructor(
    private readonly host: LeaderControlsHost,
    private readonly logger: Logger,
  ) {
    const now = (): number => host.now();
    this.viceLimiter = new SlidingWindowRateLimiter(now, LEADER_CONTROL_WINDOW_MS);
    this.lockLimiter = new SlidingWindowRateLimiter(now, LEADER_CONTROL_WINDOW_MS);
    this.removeLimiter = new SlidingWindowRateLimiter(now, LEADER_CONTROL_WINDOW_MS);
    this.activityLimiter = new SlidingWindowRateLimiter(now, LEADER_CONTROL_WINDOW_MS);
    this.takeBackLimiter = new SlidingWindowRateLimiter(now, LEADER_CONTROL_WINDOW_MS);
  }

  /**
   * leader.takeBack (#13 AC24, AC25, 6.6, RC2): only the session that owns
   * the most recent displaced leader may take back; anyone else gets
   * NOT_ALLOWED with no state change and no budget spent. Then the per-group
   * limiter, then the swap (term from nextTerm, escalated false, the slot
   * now holds the leader it replaced).
   */
  takeBack(session: Session, _message: LeaderTakeBackMessage): Promise<ServerMessage> {
    return this.host.asMember(session, async (record, membership) => {
      if (
        record.displacedLeaderId === undefined ||
        membership.participantId !== record.displacedLeaderId
      ) {
        return actionErrorMessage(ErrorCode.NOT_ALLOWED, 'leader.takeBack');
      }
      const rate = this.takeBackLimiter.tryAcquire(
        groupKey(record),
        TAKE_BACKS_PER_GROUP_PER_MINUTE,
      );
      if (!rate.ok) {
        return actionErrorMessage(ErrorCode.RATE_LIMITED, 'leader.takeBack', {
          details: { retryAfterMs: rate.retryAfterMs },
        });
      }
      return this.host.takeBackFor(session, record, membership.participantId);
    });
  }

  /**
   * leader.activity and keepalive.ack (#13 AC16, AC30, L5): the activity
   * itself is counted by the facade for every accepted leader action. The
   * shared budget is charged after authorization; the first keepalive.ack
   * while a prompt is outstanding is always accepted and not charged.
   */
  leaderActivity(
    session: Session,
    message: LeaderActivityMessage | KeepAliveAckMessage,
  ): Promise<ServerMessage> {
    return this.host.asLeader(session, message.type, (record) => {
      const free = message.type === 'keepalive.ack' && record.keepAlivePending;
      if (!free) {
        const rate = this.activityLimiter.tryAcquire(
          groupKey(record),
          LEADER_ACTIVITY_PER_GROUP_PER_MINUTE,
        );
        if (!rate.ok) {
          return Promise.resolve(
            actionErrorMessage(ErrorCode.RATE_LIMITED, message.type, {
              details: { retryAfterMs: rate.retryAfterMs },
            }),
          );
        }
      }
      return Promise.resolve({ type: 'activity.ack' });
    });
  }

  /**
   * member.remove (#13 AC32-AC34, RC4, 6.7). Order: authorization; the
   * target is any roster entry, connected or offline, not the leader
   * (NOT_ALLOWED); a full block list answers BLOCK_LIST_FULL; then the
   * per-group limiter; then a full new code set is claimed, so the removal
   * happens completely or not at all (CODES_EXHAUSTED). Effect: block-list
   * append, detach with `group.ended removed` and close 4004, roster
   * removal, vice cleared, codes and QR ticket generation rotated. The reply
   * carries the full block list for the leader's client to keep; then
   * `codes.updated {reason: 'member_removed'}`.
   */
  removeMember(session: Session, message: MemberRemoveMessage): Promise<ServerMessage> {
    return this.host.asLeader(session, 'member.remove', async (record) => {
      const target = message.participantId;
      if (target === record.leaderId) {
        return actionErrorMessage(ErrorCode.NOT_ALLOWED, 'member.remove');
      }
      if (find(record.roster, target) === undefined) return PARTICIPANT_NOT_FOUND;
      if (record.blockList.length >= MAX_BLOCK_LIST_SIZE) {
        return errorMessage(ErrorCode.BLOCK_LIST_FULL, {
          details: { maxBlockList: MAX_BLOCK_LIST_SIZE },
        });
      }
      const rate = this.removeLimiter.tryAcquire(
        groupKey(record),
        MEMBER_REMOVALS_PER_GROUP_PER_MINUTE,
      );
      if (!rate.ok) {
        return actionErrorMessage(ErrorCode.RATE_LIMITED, 'member.remove', {
          details: { retryAfterMs: rate.retryAfterMs },
        });
      }
      const next = this.host.claimFullSet(record);
      if (next === 'exhausted') return errorMessage(ErrorCode.CODES_EXHAUSTED);
      const refused = await this.host.block(session.app, record, [target]);
      if (refused !== undefined) {
        this.host.releaseClaim(record, next);
        return refused;
      }
      const blocked = (await this.host.get(record)) ?? record;
      const rotated = (await this.host.commitFullSet(blocked, next, session)) ?? blocked;
      this.host.deliverLater(session, {
        type: 'codes.updated',
        groupId: rotated.id,
        reason: 'member_removed',
        codes: this.host.codesPayload(rotated),
      });
      this.logger.info(
        { event: 'member_removed', namespace: record.appNamespace, groupRef: groupRef(record.id) },
        'member removed',
      );
      return {
        type: 'member.removed',
        groupId: rotated.id,
        participantId: target,
        blockList: [...rotated.blockList],
      };
    });
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
    this.removeLimiter.forget(`${namespace}:${groupId}`);
    this.activityLimiter.forget(`${namespace}:${groupId}`);
    this.takeBackLimiter.forget(`${namespace}:${groupId}`);
  }

  /** Server shutdown (#13 RC2). */
  close(): void {
    this.viceLimiter.clear();
    this.lockLimiter.clear();
    this.removeLimiter.clear();
    this.activityLimiter.clear();
    this.takeBackLimiter.clear();
  }

  /** Number of tracked limiter keys. For tests only. */
  get limiterSize(): number {
    return (
      this.viceLimiter.size +
      this.lockLimiter.size +
      this.removeLimiter.size +
      this.activityLimiter.size +
      this.takeBackLimiter.size
    );
  }
}
