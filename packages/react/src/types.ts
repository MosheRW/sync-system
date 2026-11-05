import type {
  JoinCodes,
  JoinedGroup,
  JoinRequest,
  KeepAliveEvent,
  LeaderState,
  LeadershipReason,
  NowLeadingEvent,
  PreviewState,
  QrTicket,
  RosterEntry,
  StoredGroupStatus,
  SyncClient,
  SyncClientError,
  SyncClientSnapshot,
} from '@sync-system/client';

/**
 * The client surface the package uses (D9). A `SyncClient` satisfies it;
 * tests and apps may pass any object that does.
 */
export type SyncClientLike = Pick<
  SyncClient,
  | 'connect'
  | 'close'
  | 'getState'
  | 'getSnapshot'
  | 'subscribe'
  | 'on'
  | 'off'
  | 'createGroup'
  | 'joinByCode'
  | 'joinByQr'
  | 'cancelJoin'
  | 'checkTokens'
  | 'resumeGroup'
  | 'endGroup'
  | 'leaveGroup'
  | 'updatePosition'
  | 'getJoinCodes'
  | 'getJoinRequests'
  | 'rotateCodes'
  | 'issueQrTicket'
  | 'approveJoin'
  | 'denyJoin'
  | 'getRoster'
  | 'getLeaderState'
  | 'setViceLeader'
  | 'clearViceLeader'
  | 'lockGroup'
  | 'unlockGroup'
  | 'removeMember'
  | 'getBlockList'
  | 'addToBlockList'
  | 'answerKeepAlive'
  | 'takeBackLeadership'
  | 'preview'
>;

/** What every action resolves with (D8): actions never reject. */
export type ActionResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SyncClientError };

/** An action hook's state (D8). */
export interface ActionState<A extends unknown[], T> {
  /** Stable identity. Never rejects; also sets pending/error/value. */
  readonly run: (...args: A) => Promise<ActionResult<T>>;
  readonly pending: boolean;
  readonly error: SyncClientError | null;
  readonly value: T | undefined;
  readonly reset: () => void;
}

/** "Update required" (AC14), discriminated on `kind`. */
export type UpdateRequired =
  /** `APP_VERSION_TOO_OLD` */
  | { readonly kind: 'app'; readonly minAppVersion?: string }
  /** `PROTOCOL_TOO_OLD` */
  | { readonly kind: 'protocol'; readonly minProtocolVersion?: number }
  /** `SERVER_UNSUPPORTED` */
  | {
      readonly kind: 'server_unsupported';
      readonly serverProtocolVersion: number;
      readonly serverMinProtocolVersion: number;
    };

/** The last leadership change this client saw (AC21). `at` is local epoch ms. */
export type LeadershipChange =
  | {
      readonly kind: 'now_leading';
      readonly groupId: string;
      readonly reason: NowLeadingEvent['reason'];
      readonly at: number;
    }
  | {
      readonly kind: 'lost';
      readonly groupId: string;
      readonly reason: LeadershipReason;
      readonly takeBackAvailable: boolean;
      readonly at: number;
    }
  | {
      readonly kind: 'changed';
      readonly groupId: string;
      readonly reason: LeadershipReason;
      readonly at: number;
    };

/** The join flow (AC17), from the last join call and the snapshot. */
export type JoinFlowState =
  | { readonly status: 'idle' }
  | { readonly status: 'joining' }
  /** Waiting for the leader's approval (snapshot `awaiting_approval`). */
  | { readonly status: 'waiting'; readonly requestId: string; readonly expiresAt: number }
  /** `JOIN_PAUSED`: door-code joining is paused (Q-B); `retryAt` is local epoch ms. */
  | { readonly status: 'paused'; readonly retryAt: number | undefined }
  /** `approved`: admitted after waiting for approval; `joined`: admitted directly. */
  | { readonly status: 'approved' | 'joined'; readonly group: JoinedGroup }
  /** `JOIN_DENIED` */
  | { readonly status: 'denied' }
  /** `JOIN_CANCELLED` (cancel) or `APPROVAL_TIMEOUT` (timeout). */
  | { readonly status: 'withdrawn'; readonly reason: 'cancelled' | 'timeout' }
  | { readonly status: 'failed'; readonly error: SyncClientError };

/** The QR ticket controller's state (AC18). */
export type QrTicketState =
  /** Not a connected leader, disabled, or no consumer mounted. */
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly ticket: QrTicket | null }
  | { readonly status: 'ready'; readonly ticket: QrTicket }
  /** `JOIN_METHOD_UNAVAILABLE`: the group has no method D. */
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'error';
      readonly error: SyncClientError;
      readonly ticket: QrTicket | null;
    };

/** One stored group with its availability (AC16). */
export interface StoredGroup extends StoredGroupStatus {
  /** live: `live`; resumable: `recoverable`, `waiting`; gone: `blocked`, `ended`, `expired`, `invalid`. */
  readonly availability: 'live' | 'resumable' | 'gone';
}

/** Door-code joining is paused for the group this client leads. */
export interface JoinPausedState {
  readonly groupId: string;
  /** Local epoch ms. */
  readonly retryAt: number;
}

/**
 * Everything the hooks read, as one immutable value that keeps its identity
 * until something changes (D2). Leader-only parts are empty unless this
 * client leads the current active group (R3).
 */
export interface SyncState {
  readonly snapshot: SyncClientSnapshot;
  readonly codes: JoinCodes | null;
  readonly joinRequests: readonly JoinRequest[];
  readonly roster: readonly RosterEntry[];
  readonly leaderState: LeaderState | null;
  readonly blockList: readonly string[];
  readonly joinPaused: JoinPausedState | null;
  readonly keepAlive: KeepAliveEvent | null;
  readonly isVice: boolean;
  readonly leadership: LeadershipChange | null;
  readonly lastError: SyncClientError | null;
  readonly joinFlow: JoinFlowState;
  readonly preview: PreviewState;
  readonly storedGroups: readonly StoredGroup[] | null;
  readonly qr: QrTicketState;
}
