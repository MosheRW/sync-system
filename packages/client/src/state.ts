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
