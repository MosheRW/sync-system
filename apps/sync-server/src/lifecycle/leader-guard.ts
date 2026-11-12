import { ErrorCode, type ErrorMessage } from '@sync-system/protocol';
import type { GroupRecord } from '../groups/group-store.js';
import type { Recipient } from '../groups/recipients.js';
import type { Membership, Session } from '../groups/session.js';
import { type ErrorAction, actionErrorMessage, errorMessage } from '../ws/error-messages.js';

/** Every leader-only action, each with its own NOT_LEADER text (#7 A1, #10 R12). */
export type LeaderAction = ErrorAction<'NOT_LEADER'>;

/** What `authorizeLeader` needs to know about the requesting session. */
export interface LeaderGuardInput {
  /** The session asking. */
  session: Pick<Session, 'parked' | 'pendingJoin'>;
  /** The session's membership if the notifier says it still owns it (M4), else undefined. */
  owned: Membership | undefined;
  /** The group the action targets: the one the lock was taken for. */
  groupId: string;
  /** The live group record, read under the group lock. */
  record: GroupRecord | undefined;
}

/**
 * The only leader check (#13 D1, RC1). Called **inside** the group lock,
 * with the record read under that lock, before any effect, budget or
 * activity. Authority comes from `record.leaderId`, never from a token or a
 * cached session role. In this order:
 * 1. a parked session or a pending joiner: NOT_LEADER;
 * 2. no owned membership, or one of another group: NOT_IN_GROUP;
 * 3. the group is not in memory: NOT_IN_GROUP;
 * 4. the owned participant is not the record's leader: NOT_LEADER.
 */
export function authorizeLeader(
  input: LeaderGuardInput,
  action: LeaderAction,
): Membership | ErrorMessage {
  const { session, owned, groupId, record } = input;
  if (session.parked !== undefined || session.pendingJoin !== undefined) {
    return actionErrorMessage(ErrorCode.NOT_LEADER, action);
  }
  if (owned === undefined || owned.groupId !== groupId) return errorMessage(ErrorCode.NOT_IN_GROUP);
  if (record === undefined) return errorMessage(ErrorCode.NOT_IN_GROUP);
  if (record.leaderId !== owned.participantId) {
    return actionErrorMessage(ErrorCode.NOT_LEADER, action);
  }
  return owned;
}

/** True when `value` is the error branch of `authorizeLeader`. */
export function isGuardError(value: Membership | ErrorMessage): value is ErrorMessage {
  return 'type' in value && value.type === 'error';
}

/**
 * Whether an open session currently owns the participant's membership
 * (#13 RC19): a late close of an old socket must not pause or end a group
 * whose participant has already resumed on a new one.
 */
export function isParticipantConnected(owner: Recipient | undefined): boolean {
  return owner !== undefined && owner.isOpen();
}
