import type { AppLimits, JsonObject, JsonValue } from '@sync-system/protocol';
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

/** Why a group ended for this client. */
export type GroupEndedReason = 'leader_disconnected' | 'rejoin_failed' | 'closed';

export interface GroupEndedInfo {
  readonly groupId: string;
  readonly reason: GroupEndedReason;
  readonly code?: ClientErrorCode;
}

/** The client's group, if any. `metadata` is `null` for a leader, which created it. */
export type GroupState =
  | {
      readonly status: 'active';
      readonly groupId: string;
      readonly role: 'leader' | 'member';
      readonly metadata: JsonObject | null;
      readonly hasPosition: boolean;
      readonly position: JsonValue | undefined;
    }
  | {
      readonly status: 'rejoining';
      readonly groupId: string;
      readonly role: 'member';
      readonly metadata: JsonObject;
      readonly hasPosition: boolean;
      readonly position: JsonValue | undefined;
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

export interface PositionUpdatedEvent {
  readonly groupId: string;
  readonly position: JsonValue;
}

/** Typed events (AC19). */
export interface SyncClientEvents {
  state: ConnectionState;
  positionUpdated: PositionUpdatedEvent;
  groupEnded: GroupEndedInfo;
  rejoined: JoinedGroup;
  error: SyncClientError;
}

/** What an app shows for the PRD's sync indicator (AC25). */
export type SyncIndicator = 'none' | 'following' | 'leading' | 'reconnecting' | 'leader_offline';

/**
 * Maps a snapshot to the indicator (AC25, documented in the README):
 * - group `ended` (any connection state): `leader_offline` (in #1 a leader
 *   drop ends the group; item 5 adds a grace period), except a group the
 *   app itself left with `close()` (reason `closed`): `none`;
 * - connecting or reconnecting with an active or rejoining group: `reconnecting`;
 * - connected with a rejoining group: `reconnecting`;
 * - connected with an active group: `following` (member) or `leading` (leader);
 * - anything else: `none`.
 */
export function indicatorOf(snapshot: SyncClientSnapshot): SyncIndicator {
  const { connection, group } = snapshot;
  if (group === null) return 'none';
  if (group.status === 'ended') return group.reason === 'closed' ? 'none' : 'leader_offline';
  if (connection.status === 'connecting' || connection.status === 'reconnecting') {
    return 'reconnecting';
  }
  if (connection.status !== 'connected') return 'none';
  if (group.status === 'rejoining') return 'reconnecting';
  return group.role === 'leader' ? 'leading' : 'following';
}
