import {
  ErrorCode,
  GROUP_ID_PATTERN,
  type GroupCreateMessage,
  type GroupJoinMessage,
  type PositionUpdateMessage,
  type ServerMessage,
} from '@sync-system/protocol';
import { jsonByteLength } from '../limits/json-size.js';
import type { SlidingWindowRateLimiter } from '../limits/rate-limiter.js';
import { type Logger, groupRef, participantRef } from '../logging/logger.js';
import { errorMessage } from '../ws/error-messages.js';
import type { GroupRecord, GroupStore } from './group-store.js';
import { newGroupId } from './ids.js';
import type { Notifier } from './notifier.js';
import type { GroupActions, Session } from './session.js';

export interface GroupServiceDeps {
  store: GroupStore;
  notifier: Notifier;
  logger: Logger;
  now: () => number;
  /** Leader update limiter, keyed by group (AC22). */
  rateLimiter: SlidingWindowRateLimiter;
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

function rateKey(namespace: string, groupId: string): string {
  return `${namespace}:${groupId}`;
}

/**
 * Group business rules. Never reads the fields of `position` or `metadata`:
 * they are stored and relayed as the parsed references (AC14).
 */
export class GroupService implements GroupActions {
  constructor(private readonly deps: GroupServiceDeps) {}

  attach(session: Session): void {
    this.deps.notifier.register(session);
  }

  async create(session: Session, message: GroupCreateMessage): Promise<ServerMessage> {
    if (session.groupId !== undefined) return errorMessage(ErrorCode.ALREADY_IN_GROUP);

    const { app } = session;
    // Checked before anything is stored: an oversized create leaves no group.
    const tooLarge =
      sizeError('metadata', message.metadata, app.maxMessageBytes) ??
      (message.position === undefined
        ? undefined
        : sizeError('position', message.position, app.maxMessageBytes));
    if (tooLarge) return tooLarge;

    const record: GroupRecord = {
      id: newGroupId(),
      appNamespace: app.namespace,
      metadata: message.metadata,
      position:
        message.position === undefined ? { has: false } : { has: true, payload: message.position },
      leaderId: session.participantId,
      participantIds: [session.participantId],
      createdAt: this.deps.now(),
    };
    await this.deps.store.create(record);
    session.groupId = record.id;
    session.role = 'leader';
    this.deps.logger.info(
      { event: 'group_created', namespace: app.namespace, groupRef: groupRef(record.id) },
      'group created',
    );
    return {
      type: 'group.created',
      groupId: record.id,
      participantId: session.participantId,
      role: 'leader',
    };
  }

  async join(session: Session, message: GroupJoinMessage): Promise<ServerMessage> {
    if (session.groupId !== undefined) return errorMessage(ErrorCode.ALREADY_IN_GROUP);

    const { app } = session;
    const { groupId } = message;
    // A malformed ID gets the same answer as an unknown one: no oracle (L3).
    if (!GROUP_ID_PATTERN.test(groupId)) return errorMessage(ErrorCode.GROUP_NOT_FOUND);

    const added = await this.deps.store.addParticipant(
      app.namespace,
      groupId,
      session.participantId,
      app.maxGroupSize,
    );
    if (added.status === 'not_found') return errorMessage(ErrorCode.GROUP_NOT_FOUND);
    // The leader counts toward the size (AC21).
    if (added.status === 'full') {
      return errorMessage(ErrorCode.GROUP_FULL, { details: { maxGroupSize: app.maxGroupSize } });
    }
    // The snapshot comes from the same atomic insert. A second read could
    // fail after the insert and leave the participant in the group while the
    // session stays groupless.
    const record = added.group;

    session.groupId = groupId;
    session.role = 'member';
    this.deps.logger.info(
      {
        event: 'group_joined',
        namespace: app.namespace,
        groupRef: groupRef(groupId),
        participantRef: participantRef(session.participantId),
      },
      'group joined',
    );
    const base = {
      type: 'group.joined' as const,
      groupId,
      participantId: session.participantId,
      role: 'member' as const,
      metadata: record.metadata,
    };
    return record.position.has
      ? { ...base, hasPosition: true, position: record.position.payload }
      : { ...base, hasPosition: false };
  }

  async update(session: Session, message: PositionUpdateMessage): Promise<ServerMessage> {
    const { groupId } = session;
    if (groupId === undefined) return errorMessage(ErrorCode.NOT_IN_GROUP);
    if (session.role !== 'leader') return errorMessage(ErrorCode.NOT_LEADER);

    const { app } = session;
    const namespace = app.namespace;
    const tooLarge = sizeError('position', message.position, app.maxMessageBytes);
    if (tooLarge) return tooLarge;

    // Checked last, so rejected updates never use rate budget. Over-rate
    // updates are rejected, never queued or coalesced (AC22).
    const rate = this.deps.rateLimiter.tryAcquire(
      rateKey(namespace, groupId),
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

    const stored = await this.deps.store.setPosition(namespace, groupId, message.position);
    if (!stored) return errorMessage(ErrorCode.NOT_IN_GROUP);

    const record = await this.deps.store.get(namespace, groupId);
    if (record) {
      // Members only: the leader gets position.ack, not the broadcast (AC13).
      const members = record.participantIds.filter((id) => id !== record.leaderId);
      this.deps.notifier.broadcast(members, {
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

  async disconnect(session: Session): Promise<void> {
    this.deps.notifier.unregister(session.participantId);
    const { groupId } = session;
    if (groupId === undefined) return;
    const namespace = session.app.namespace;
    const wasLeader = session.role === 'leader';
    session.groupId = undefined;
    session.role = undefined;

    if (wasLeader) {
      await this.endGroup(namespace, groupId, session.participantId);
      return;
    }

    const result = await this.deps.store.removeParticipant(
      namespace,
      groupId,
      session.participantId,
    );
    if (result && result.remaining === 0) {
      await this.deps.store.delete(namespace, groupId);
      this.deps.rateLimiter.forget(rateKey(namespace, groupId));
      this.deps.logger.info(
        { event: 'group_deleted', namespace, groupRef: groupRef(groupId) },
        'group deleted',
      );
    }
  }

  /**
   * In this issue a leader disconnect ends the group (AC17): the group is
   * deleted, remaining members become groupless (their sockets stay open)
   * and get group.ended.
   */
  private async endGroup(namespace: string, groupId: string, leaderId: string): Promise<void> {
    const record = await this.deps.store.get(namespace, groupId);
    await this.deps.store.delete(namespace, groupId);
    this.deps.rateLimiter.forget(rateKey(namespace, groupId));
    const members = (record?.participantIds ?? []).filter((id) => id !== leaderId);
    for (const memberId of members) {
      const member = this.deps.notifier.get(memberId);
      if (member && member.groupId === groupId) {
        member.groupId = undefined;
        member.role = undefined;
      }
    }
    this.deps.notifier.broadcast(members, {
      type: 'group.ended',
      groupId,
      reason: 'leader_disconnected',
    });
    this.deps.logger.info(
      { event: 'group_ended', namespace, groupRef: groupRef(groupId), members: members.length },
      'group ended',
    );
  }
}
