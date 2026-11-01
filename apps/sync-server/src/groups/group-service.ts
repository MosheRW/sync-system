import {
  ErrorCode,
  GROUP_ID_PATTERN,
  type GroupCreateMessage,
  type GroupJoinMessage,
  type PositionUpdateMessage,
  type ServerMessage,
} from '@sync-system/protocol';
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
      Number.POSITIVE_INFINITY,
    );
    if (added !== 'ok') return errorMessage(ErrorCode.GROUP_NOT_FOUND);

    const record = await this.deps.store.get(app.namespace, groupId);
    if (!record) return errorMessage(ErrorCode.GROUP_NOT_FOUND);

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

    const namespace = session.app.namespace;
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
    session.groupId = undefined;
    session.role = undefined;

    const result = await this.deps.store.removeParticipant(
      namespace,
      groupId,
      session.participantId,
    );
    if (result && result.remaining === 0) {
      await this.deps.store.delete(namespace, groupId);
      this.deps.logger.info(
        { event: 'group_deleted', namespace, groupRef: groupRef(groupId) },
        'group deleted',
      );
    }
  }
}
