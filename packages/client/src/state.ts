import type { AppLimits, JsonObject, JsonValue, Role, TokenStatus } from '@sync-system/protocol';
import type { ClientErrorCode, SyncClientError } from './errors.js';

/** Why the client is closed (AC24). */
export type ClosedReason = 'client' | 'fatal' | 'gave_up';

/**
 * Connection state (AC24), a discriminated union on `status`:
 * - `idle`: created, `connect()` not called yet;
 * - `connecting`: first attempt after `connect()` (socket opening + handshake);
 * - `connected`: `hello.ok` received; group calls are allowed;
 * - `reconnecting`: waiting for the backoff timer (`attempting: false`) or
 *   retrying (`attempting: true`);
 * - `closed`: terminal until the app calls `connect()` again.
 */
export type ConnectionState =
  | { readonly status: 'idle' }
  | { readonly status: 'connecting' }
  | {
      readonly status: 'connected';
      readonly participantId: string;
      readonly namespace: string;
      readonly limits: Readonly<AppLimits>;
    }
  | {
      readonly status: 'reconnecting';
      /** 1-based number of the reconnect attempt. */
      readonly attempt: number;
      readonly delayMs: number;
      /** Epoch ms when the attempt starts. */
      readonly retryAt: number;
      readonly attempting: boolean;
    }
  | { readonly status: 'closed'; readonly reason: ClosedReason; readonly error?: SyncClientError };

/**
 * Why a group ended for this client (#5):
 * - `ended_by_leader`, `leader_timeout`, `max_session`, `removed`: the
 *   server's `group.ended` reasons (the token is deleted);
 * - `replaced`: the same participant resumed on another connection (another
 *   tab or device). The token is kept and nothing is resumed automatically;
 * - `left`: `leaveGroup()` or `endGroup()` succeeded;
 * - `rejoin_failed`: getting back in after a drop failed (`code` says why);
 * - `closed`: the app called `close()` (tokens are kept).
 */
export type GroupEndedReason =
  | 'ended_by_leader'
  | 'leader_timeout'
  | 'max_session'
  | 'replaced'
  | 'removed'
  | 'left'
  | 'rejoin_failed'
  | 'closed';

export interface GroupEndedInfo {
  readonly groupId: string;
  readonly reason: GroupEndedReason;
  readonly code?: ClientErrorCode;
}

/** The client's group, if any (#5 AC36). */
export type GroupState =
  | {
      readonly status: 'active';
      readonly groupId: string;
      readonly role: Role;
      /** The group's metadata (for a leader too: it is recovery data). */
      readonly metadata: JsonObject;
      readonly hasPosition: boolean;
      readonly position: JsonValue | undefined;
      /** False while the leader is offline (members only; always true for a leader). */
      readonly leaderOnline: boolean;
    }
  | {
      /** Dropped; resuming with the stored token after the reconnect. */
      readonly status: 'rejoining';
      readonly groupId: string;
      readonly role: Role;
      readonly metadata: JsonObject | null;
      readonly hasPosition: boolean;
      readonly position: JsonValue | undefined;
    }
  | {
      /** A member parked by the server until its leader recreates the group. */
      readonly status: 'waiting';
      readonly groupId: string;
      readonly role: 'member';
    }
  | {
      readonly status: 'ended';
      readonly groupId: string;
      readonly reason: GroupEndedReason;
      readonly code?: ClientErrorCode;
    };

/**
 * Immutable snapshot for `useSyncExternalStore`: it keeps its identity
 * until something changes.
 */
export interface SyncClientSnapshot {
  readonly connection: ConnectionState;
  /** `null`: never in a group (or after `connect()` on a closed client). */
  readonly group: GroupState | null;
}

export interface ConnectedInfo {
  readonly participantId: string;
  /** The app's namespace from `hello.ok` (#5 AC33). */
  readonly namespace: string;
  readonly limits: Readonly<AppLimits>;
}

export interface CreatedGroup {
  readonly groupId: string;
  readonly role: 'leader';
  readonly participantId: string;
}

export interface JoinedGroup {
  readonly groupId: string;
  readonly role: 'member';
  readonly participantId: string;
  readonly metadata: JsonObject;
  /** `false` is the explicit "no position yet". */
  readonly hasPosition: boolean;
  readonly position?: JsonValue;
}

/** Result of a resume (`resumeGroup()`, and the `rejoined` event) (#5 AC38). */
export interface ResumedGroup {
  readonly groupId: string;
  readonly role: Role;
  readonly participantId: string;
  /** `waiting`: a member parked until its leader recreates the group. */
  readonly status: 'active' | 'waiting';
  /** True when the server rebuilt the group from this leader's token. */
  readonly recreated: boolean;
  readonly leaderOnline: boolean;
  readonly metadata?: JsonObject;
  readonly hasPosition: boolean;
  readonly position?: JsonValue;
}

/** Leader overrides for `resumeGroup()` (the saved recovery data is used otherwise). */
export interface ResumeOptions {
  readonly metadata?: JsonObject;
  readonly position?: JsonValue;
}

/** One stored group as reported by `checkTokens()` (#5 AC37). */
export interface StoredGroupStatus {
  readonly groupId: string;
  readonly role: Role;
  readonly status: TokenStatus;
}

export interface PositionUpdatedEvent {
  readonly groupId: string;
  readonly position: JsonValue;
}

/** A member's group: the leader went offline or came back (#5 AC36). */
export interface LeaderStatusEvent {
  readonly groupId: string;
  readonly online: boolean;
}

/** Typed events (AC19). */
export interface SyncClientEvents {
  state: ConnectionState;
  positionUpdated: PositionUpdatedEvent;
  groupEnded: GroupEndedInfo;
  rejoined: ResumedGroup;
  leaderStatus: LeaderStatusEvent;
  error: SyncClientError;
}

/** What an app shows for the PRD's sync indicator (AC25). */
export type SyncIndicator = 'none' | 'following' | 'leading' | 'reconnecting' | 'leader_offline';

/**
 * Maps a snapshot to the indicator (#5 AC36, Q-E; documented in the README):
 * - no group, or an `ended` group (any reason): `none`;
 * - connecting or reconnecting with an active, rejoining or waiting group:
 *   `reconnecting`;
 * - connected with a rejoining group: `reconnecting`;
 * - connected and waiting for the leader: `leader_offline`;
 * - connected, active member, leader offline: `leader_offline`;
 * - connected, active member, leader online: `following`;
 * - connected, active leader: `leading`;
 * - anything else: `none`.
 */
export function indicatorOf(snapshot: SyncClientSnapshot): SyncIndicator {
  const { connection, group } = snapshot;
  if (group === null || group.status === 'ended') return 'none';
  if (connection.status === 'connecting' || connection.status === 'reconnecting') {
    return 'reconnecting';
  }
  if (connection.status !== 'connected') return 'none';
  if (group.status === 'rejoining') return 'reconnecting';
  if (group.status === 'waiting') return 'leader_offline';
  if (group.role === 'leader') return 'leading';
  return group.leaderOnline ? 'following' : 'leader_offline';
}
