import {
  ErrorCode,
  GROUP_ID_PATTERN,
  type GroupCreateMessage,
  type GroupEndedReason,
  type GroupJoinMessage,
  type PositionUpdateMessage,
  type Role,
  type ServerMessage,
} from '@sync-system/protocol';
import type { AppConfig } from '../apps/app-registry.js';
import { jsonByteLength } from '../limits/json-size.js';
import type { SlidingWindowRateLimiter } from '../limits/rate-limiter.js';
import { type Logger, groupRef, participantRef, safeErr } from '../logging/logger.js';
import type { Scheduler } from '../time/scheduler.js';
import type { TokenService } from '../tokens/token-service.js';
import { errorMessage } from '../ws/error-messages.js';
import { type GroupRecord, type GroupStore, connectedCount } from './group-store.js';
import { GroupTimers } from './group-timers.js';
import { newGroupId, newParticipantId } from './ids.js';
import { KeyedLock } from './keyed-lock.js';
import type { Notifier } from './notifier.js';
import { type GroupActions, type Membership, type Session, membershipKey } from './session.js';

export interface GroupServiceDeps {
  store: GroupStore;
  notifier: Notifier;
  logger: Logger;
  /** Clock and timers (frozen-group end). */
  scheduler: Scheduler;
  /** Leader update limiter, keyed by group (AC22). */
  rateLimiter: SlidingWindowRateLimiter;
  /** Issues participant tokens (#5 AC5). */
  tokens: TokenService;
  /** Max interval between leader token refreshes in ms; also the recovery slack (Q10). */
  refreshMaxMs: number;
}

/**
 * MESSAGE_TOO_LARGE if `value` is over the app's limit, else undefined. A value
 * exactly at the limit is accepted (AC27).
 */
function sizeError(
  field: 'position' | 'metadata',
  value: unknown,
  limitBytes: number,
): ServerMessage | undefined {
  if (jsonByteLength(value) <= limitBytes) return undefined;
  return errorMessage(ErrorCode.MESSAGE_TOO_LARGE, { details: { field, limitBytes } });
}

function groupKey(namespace: string, groupId: string): string {
  return `${namespace}:${groupId}`;
}

const MINUTE_MS = 60_000;

/**
 * Group business rules. Never reads the fields of `position` or `metadata`:
 * they are stored and relayed as the parsed references (AC14).
 *
 * Participant IDs are group-scoped: a new one is minted for every create and
 * join. They appear in replies to their owner only, and never in logs (L7).
 *
 * Every state change of a group runs under its per-group lock, timer
 * callbacks included; those re-read the group, since a timer may be stale.
 */
export class GroupService implements GroupActions {
  /** Serializes join and teardown per group (namespace + ID). */
  private readonly locks = new KeyedLock();
  private readonly timers: GroupTimers;

  constructor(private readonly deps: GroupServiceDeps) {
    this.timers = new GroupTimers(deps.scheduler);
  }

  /** Cancels every group timer (server shutdown). */
  close(): void {
    this.timers.clearAll();
  }

  /** Number of groups with a pending timer. For tests only. */
  get timerCount(): number {
    return this.timers.size;
  }

  private now(): number {
    return this.deps.scheduler.now();
  }

  /** The session's membership if the session still owns it in the notifier (M4). */
  private owned(session: Session): Membership | undefined {
    const membership = session.membership;
    if (membership === undefined) return undefined;
    const key = membershipKey(session.app.namespace, membership.groupId, membership.participantId);
    return this.deps.notifier.get(key) === session ? membership : undefined;
  }

  private attach(session: Session, membership: Membership): void {
    session.membership = membership;
    this.deps.notifier.register(
      membershipKey(session.app.namespace, membership.groupId, membership.participantId),
      session,
    );
  }

  private issueToken(
    app: AppConfig,
    record: GroupRecord,
    participantId: string,
    role: Role,
    now: number,
  ): string {
    return this.deps.tokens.issue({
      namespace: app.namespace,
      groupId: record.id,
      participantId,
      role,
      groupCreatedAt: record.createdAt,
      lastActivityAt: record.lastActivityAt,
      now,
    });
  }

  /** When a frozen group ends: the recovery window after the leader's last activity. */
  private frozenEndAt(app: AppConfig, record: GroupRecord): number {
    return record.lastActivityAt + app.inactivityLimitMinutes * MINUTE_MS + this.deps.refreshMaxMs;
  }

  private maxSessionEndAt(app: AppConfig, record: GroupRecord): number {
    return record.createdAt + app.maxSessionMinutes * MINUTE_MS;
  }

  /**
   * Arms the max-session timer (#5 AC21, Q2): the group ends with
   * `max_session` at `createdAt + maxSessionMinutes`, leader online or not.
   */
  private armMaxSession(app: AppConfig, record: GroupRecord): void {
    const namespace = app.namespace;
    const groupId = record.id;
    this.timers.armMaxSession(
      groupKey(namespace, groupId),
      this.maxSessionEndAt(app, record),
      () => {
        this.runTimer(namespace, groupId, async () => {
          const current = await this.deps.store.get(namespace, groupId);
          if (!current) return;
          // Re-checked against the clock under the lock (R3).
          if (this.maxSessionEndAt(app, current) > this.now()) {
            this.armMaxSession(app, current);
            return;
          }
          await this.endGroup(namespace, groupId, 'max_session');
        });
      },
    );
  }

  /** Runs a timer callback under the group lock; failures are logged, never thrown. */
  private runTimer(namespace: string, groupId: string, task: () => Promise<void>): void {
    this.locks.run(groupKey(namespace, groupId), task).catch((err: unknown) => {
      this.deps.logger.error({ event: 'timer_error', err: safeErr(err) }, 'group timer failed');
    });
  }

  async create(session: Session, message: GroupCreateMessage): Promise<ServerMessage> {
    if (session.membership !== undefined) return errorMessage(ErrorCode.ALREADY_IN_GROUP);

    const { app } = session;
    // Checked before anything is stored: an oversized create leaves no group.
    const tooLarge =
      sizeError('metadata', message.metadata, app.maxMessageBytes) ??
      (message.position === undefined
        ? undefined
        : sizeError('position', message.position, app.maxMessageBytes));
    if (tooLarge) return tooLarge;

    const participantId = newParticipantId();
    const now = this.now();
    const record: GroupRecord = {
      id: newGroupId(),
      appNamespace: app.namespace,
      metadata: message.metadata,
      position:
        message.position === undefined ? { has: false } : { has: true, payload: message.position },
      leaderId: participantId,
      participantIds: [participantId],
      createdAt: now,
      lastActivityAt: now,
      leaderOnline: true,
      blockList: [],
    };
    await this.deps.store.create(record);
    this.armMaxSession(app, record);
    this.attach(session, { groupId: record.id, participantId, role: 'leader' });
    this.deps.logger.info(
      { event: 'group_created', namespace: app.namespace, groupRef: groupRef(record.id) },
      'group created',
    );
    const token = this.issueToken(app, record, participantId, 'leader', now);
    return { type: 'group.created', groupId: record.id, participantId, role: 'leader', token };
  }

  async join(session: Session, message: GroupJoinMessage): Promise<ServerMessage> {
    if (session.membership !== undefined) return errorMessage(ErrorCode.ALREADY_IN_GROUP);

    const { app } = session;
    const { groupId } = message;
    // A malformed ID gets the same answer as an unknown one: no oracle (L3).
    if (!GROUP_ID_PATTERN.test(groupId)) return errorMessage(ErrorCode.GROUP_NOT_FOUND);

    // Serialized with the group's teardown: the insert and the session
    // commit happen together, either fully before the group ends (so the
    // teardown sees and notifies this member) or after it (not found).
    // Without this, a slow insert reply could commit the session to a
    // group that was already deleted.
    return this.locks.run(groupKey(app.namespace, groupId), async () => {
      const participantId = newParticipantId();
      const added = await this.deps.store.addParticipant(
        app.namespace,
        groupId,
        participantId,
        app.maxGroupSize,
      );
      if (added.status === 'not_found') return errorMessage(ErrorCode.GROUP_NOT_FOUND);
      // The leader counts toward the size (AC21).
      if (added.status === 'full') {
        return errorMessage(ErrorCode.GROUP_FULL, { details: { maxGroupSize: app.maxGroupSize } });
      }
      // The snapshot comes from the same atomic insert. A second read could
      // fail after the insert and leave the participant in the group while
      // the session stays groupless.
      return this.commitJoin(session, participantId, added.group);
    });
  }

  private commitJoin(session: Session, participantId: string, record: GroupRecord): ServerMessage {
    const { app } = session;
    this.attach(session, { groupId: record.id, participantId, role: 'member' });
    this.deps.logger.info(
      {
        event: 'group_joined',
        namespace: app.namespace,
        groupRef: groupRef(record.id),
        // The connection-scoped ref only: never the group-scoped ID (L7).
        participantRef: participantRef(session.connectionId),
      },
      'group joined',
    );
    return this.joinedMessage(
      record,
      participantId,
      this.issueToken(app, record, participantId, 'member', this.now()),
    );
  }

  private joinedMessage(record: GroupRecord, participantId: string, token: string): ServerMessage {
    const base = {
      type: 'group.joined' as const,
      groupId: record.id,
      participantId,
      role: 'member' as const,
      metadata: record.metadata,
      token,
      leaderOnline: record.leaderOnline,
    };
    return record.position.has
      ? { ...base, hasPosition: true, position: record.position.payload }
      : { ...base, hasPosition: false };
  }

  async update(session: Session, message: PositionUpdateMessage): Promise<ServerMessage> {
    // Authorized by ownership, not by the cached role alone (M4).
    const membership = this.owned(session);
    if (membership === undefined) return errorMessage(ErrorCode.NOT_IN_GROUP);
    if (membership.role !== 'leader') return errorMessage(ErrorCode.NOT_LEADER);

    const { app } = session;
    const namespace = app.namespace;
    const { groupId } = membership;
    const tooLarge = sizeError('position', message.position, app.maxMessageBytes);
    if (tooLarge) return tooLarge;

    // Checked last, so rejected updates never use rate budget. Over-rate
    // updates are rejected, never queued or coalesced (AC22).
    const rate = this.deps.rateLimiter.tryAcquire(
      groupKey(namespace, groupId),
      app.maxLeaderUpdatesPerSecond,
    );
    if (!rate.ok) {
      return errorMessage(ErrorCode.RATE_LIMITED, {
        details: {
          maxLeaderUpdatesPerSecond: app.maxLeaderUpdatesPerSecond,
          retryAfterMs: rate.retryAfterMs,
        },
      });
    }

    // An accepted update is a leader activity (#5 AC12).
    const stored = await this.deps.store.setPosition(
      namespace,
      groupId,
      message.position,
      this.now(),
    );
    if (!stored) return errorMessage(ErrorCode.NOT_IN_GROUP);

    const record = await this.deps.store.get(namespace, groupId);
    if (record) {
      // Members only: the leader gets position.ack, not the broadcast (AC13).
      this.deps.notifier.broadcast(this.memberKeys(record), {
        type: 'position.updated',
        groupId,
        position: message.position,
      });
    }
    this.deps.logger.debug(
      { event: 'position_updated', namespace, groupRef: groupRef(groupId) },
      'position updated',
    );
    return { type: 'position.ack' };
  }

  private memberKeys(record: GroupRecord): string[] {
    return record.participantIds
      .filter((id) => id !== record.leaderId)
      .map((id) => membershipKey(record.appNamespace, record.id, id));
  }

  async disconnect(session: Session): Promise<void> {
    const membership = session.membership;
    if (membership === undefined) return;
    const { app } = session;
    const namespace = app.namespace;
    const { groupId, participantId } = membership;
    session.membership = undefined;
    // A session that no longer owns its membership changes nothing (M4).
    if (!this.deps.notifier.unregister(membershipKey(namespace, groupId, participantId), session)) {
      return;
    }

    // Under the group lock, so a join cannot land between the removal and
    // the delete.
    await this.locks.run(groupKey(namespace, groupId), async () => {
      if (membership.role === 'leader') {
        await this.leaderOffline(app, groupId);
        return;
      }
      const result = await this.deps.store.removeParticipant(namespace, groupId, participantId);
      if (result && result.connected === 0) await this.dropGroup(namespace, groupId);
    });
  }

  /**
   * The leader's connection closed (#5 AC18, replaces #1 AC17): the group is
   * not ended. With no member left it is dropped from memory; otherwise it is
   * frozen, members get leader.offline, and it ends when the recovery window
   * after the leader's last activity lapses (AC21). Runs under the group lock.
   */
  private async leaderOffline(app: AppConfig, groupId: string): Promise<void> {
    const namespace = app.namespace;
    const record = await this.deps.store.setLeaderOnline(namespace, groupId, false);
    if (!record) return;
    if (connectedCount(record) === 0) {
      await this.dropGroup(namespace, groupId);
      return;
    }
    this.deps.notifier.broadcast(this.memberKeys(record), { type: 'leader.offline', groupId });
    this.deps.logger.info(
      { event: 'group_frozen', namespace, groupRef: groupRef(groupId) },
      'leader offline',
    );
    await this.scheduleFrozenEnd(app, record);
  }

  /**
   * Arms the frozen-end timer, or ends the group now if its time has passed.
   * Runs under the group lock.
   */
  private async scheduleFrozenEnd(app: AppConfig, record: GroupRecord): Promise<void> {
    const at = this.frozenEndAt(app, record);
    const groupId = record.id;
    const namespace = app.namespace;
    if (this.maxSessionEndAt(app, record) <= this.now()) {
      await this.endGroup(namespace, groupId, 'max_session');
      return;
    }
    if (at <= this.now()) {
      await this.endGroup(namespace, groupId, 'leader_timeout');
      return;
    }
    // Max session comes first: its own timer ends the group.
    if (this.maxSessionEndAt(app, record) <= at) return;
    this.timers.armFrozenEnd(groupKey(namespace, groupId), at, () => {
      this.runTimer(namespace, groupId, async () => {
        const current = await this.deps.store.get(namespace, groupId);
        // Stale timer: the group is gone or the leader came back.
        if (!current || current.leaderOnline) return;
        await this.scheduleFrozenEnd(app, current);
      });
    });
  }

  /**
   * Removes a group nobody is connected to from memory (#5 AC22). This is not
   * an end: its tokens stay usable until their own limits pass.
   */
  private async dropGroup(namespace: string, groupId: string): Promise<void> {
    await this.deps.store.delete(namespace, groupId);
    this.forgetGroup(namespace, groupId);
    this.deps.logger.info(
      { event: 'group_dropped', namespace, groupRef: groupRef(groupId) },
      'group dropped',
    );
  }

  private forgetGroup(namespace: string, groupId: string): void {
    const key = groupKey(namespace, groupId);
    this.deps.rateLimiter.forget(key);
    this.timers.clear(key);
  }

  /**
   * Ends a group: it is deleted and every attached participant gets
   * group.ended with `reason`. Must run under the group lock.
   *
   * Each participant loses its membership at once (M4) and is notified
   * through its own message queue, after the replies to messages it has
   * already sent. A member whose join was in flight therefore gets
   * group.joined first, then group.ended.
   */
  private async endGroup(
    namespace: string,
    groupId: string,
    reason: GroupEndedReason,
  ): Promise<void> {
    const record = await this.deps.store.get(namespace, groupId);
    await this.deps.store.delete(namespace, groupId);
    this.forgetGroup(namespace, groupId);
    const keys = (record?.participantIds ?? []).map((id) => membershipKey(namespace, groupId, id));
    const ended = JSON.stringify({ type: 'group.ended', groupId, reason } satisfies ServerMessage);
    let notified = 0;
    for (const key of keys) {
      const participant = this.deps.notifier.get(key);
      if (participant === undefined) continue;
      notified += 1;
      this.deps.notifier.unregister(key, participant);
      if (participant.membership?.groupId === groupId) participant.membership = undefined;
      participant.afterPending(() => participant.deliver(ended));
    }
    this.deps.logger.info(
      {
        event: 'group_ended',
        namespace,
        groupRef: groupRef(groupId),
        endReason: reason,
        members: notified,
      },
      'group ended',
    );
  }
}
