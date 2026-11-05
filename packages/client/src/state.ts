import type {
  AppLimits,
  JoinMethod,
  JsonObject,
  JsonValue,
  Role,
  TokenStatus,
} from '@sync-system/protocol';
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
      readonly joinMethods: readonly JoinMethod[];
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
 * - `ended_by_leader`, `leader_timeout`, `max_session`, `removed`,
 *   `inactivity`: the server's `group.ended` reasons (the token is
 *   deleted; `inactivity`: #13 AC22);
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
  | 'inactivity'
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
    }
  | {
      /**
       * A method B join request waits for the leader (#10 AC39). No group ID:
       * the server does not reveal it before admission.
       */
      readonly status: 'awaiting_approval';
      readonly requestId: string;
      /** Local epoch ms when the server times the request out. */
      readonly expiresAt: number;
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
  /** The join methods the app allows, from `hello.ok` (#10 AC4). */
  readonly joinMethods: readonly JoinMethod[];
  readonly limits: Readonly<AppLimits>;
}

/**
 * A group's join codes, for its leader only (#10 AC6, AC40). Show them to
 * the people who should join; never log them. The signed recovery copy is
 * kept by the client and is not exposed.
 */
export interface JoinCodes {
  /** Increases on every code change. */
  readonly generation: number;
  /** 6 digits; methods A and B. */
  readonly groupCode?: string;
  /** 6 digits; method A. */
  readonly doorCode?: string;
  /** 8 characters; method C. */
  readonly alphaCode?: string;
}

export interface CreatedGroup {
  readonly groupId: string;
  readonly role: 'leader';
  readonly participantId: string;
  /** The group's join methods (#10 AC38). */
  readonly joinMethods: readonly JoinMethod[];
  /** The group's join codes (#10 AC38). */
  readonly codes: JoinCodes;
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
  /** Leader: the group's codes changed (#10 AC40). */
  codesChanged: CodesChangedEvent;
  /** Leader: someone asks to join (method B, #10 AC19). */
  joinRequested: JoinRequestedEvent;
  /** Leader: a request ended without a decision (#10 AC21). */
  joinWithdrawn: JoinWithdrawnEvent;
  /** Leader: door-code joining paused after repeated failures (#10 AC29). */
  joinPaused: JoinPausedEvent;
  /** Leader: door-code joining works again (#10 AC29, AC30). */
  joinResumed: JoinResumedEvent;
  error: SyncClientError;
}

/** Options of `createGroup()` (#10 AC38). */
export interface CreateGroupOptions {
  /**
   * The group's join methods: a non-empty subset of the app's (`hello.ok`),
   * never both A and B. Omitted: the app's methods minus B when A is allowed.
   */
  readonly joinMethods?: readonly JoinMethod[];
}

/** A QR ticket for the leader to show (#10 AC23, AC40). A bearer credential: never log or persist it. */
export interface QrTicket {
  /** Opaque, URL-safe, at most 256 characters. Put it in a URL fragment, not a query string. */
  readonly ticket: string;
  /** Local epoch ms when it stops working (local clock + the server's relative lifetime). */
  readonly expiresAt: number;
}

/** A pending join request, for the leader's approval prompt (#10 AC19, AC40). */
export interface JoinRequest {
  readonly requestId: string;
  /** Untrusted: render as text only, never as HTML. */
  readonly displayName?: string;
  /** Local epoch ms when the request times out. */
  readonly expiresAt: number;
}

/** Why the group's codes changed (#10 AC40). */
export type CodesChangedReason =
  'created' | 'resumed' | 'rotated' | 'door_failures' | 'member_removed';

export interface CodesChangedEvent {
  readonly groupId: string;
  readonly codes: JoinCodes;
  readonly reason: CodesChangedReason;
}

export interface JoinRequestedEvent extends JoinRequest {
  readonly groupId: string;
}

export interface JoinWithdrawnEvent {
  readonly groupId: string;
  readonly requestId: string;
  readonly reason: 'cancelled' | 'disconnected' | 'timeout';
}

export interface JoinPausedEvent {
  readonly groupId: string;
  readonly retryAfterMs: number;
}

export interface JoinResumedEvent {
  readonly groupId: string;
}

/** Options of `joinByCode()` (#10 AC39). */
export interface JoinOptions {
  /** Method A: the 6-digit door code. */
  readonly doorCode?: string;
  /** Method B: shown to the leader in the approval prompt (1-32 characters). */
  readonly displayName?: string;
}

/** Options of `joinByQr()` (#10 AC39). */
export interface JoinByQrOptions {
  /** Shown to the leader if the group needs approval (method B). */
  readonly displayName?: string;
}

/** What an app shows for the PRD's sync indicator (AC25). */
export type SyncIndicator =
  'none' | 'following' | 'leading' | 'reconnecting' | 'leader_offline' | 'awaiting_approval';

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
 * - connected and waiting for a leader's approval: `awaiting_approval`
 *   (the request is dropped with the connection, so otherwise `none`, #10);
 * - anything else: `none`.
 */
export function indicatorOf(snapshot: SyncClientSnapshot): SyncIndicator {
  const { connection, group } = snapshot;
  if (group === null || group.status === 'ended') return 'none';
  if (group.status === 'awaiting_approval') {
    return connection.status === 'connected' ? 'awaiting_approval' : 'none';
  }
  if (connection.status === 'connecting' || connection.status === 'reconnecting') {
    return 'reconnecting';
  }
  if (connection.status !== 'connected') return 'none';
  if (group.status === 'rejoining') return 'reconnecting';
  if (group.status === 'waiting') return 'leader_offline';
  if (group.role === 'leader') return 'leading';
  return group.leaderOnline ? 'following' : 'leader_offline';
}
