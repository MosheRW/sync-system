import type { ErrorCode } from './errors.js';
import type { JoinMethod } from './join.js';
import type { JsonObject, JsonValue } from './json.js';

/** Role of a participant in a group. Later issues add more roles. */
export type Role = 'leader' | 'member';

/**
 * Why a group ended for the receiver (#5):
 * - `ended_by_leader`: the leader sent group.end;
 * - `leader_timeout`: the leader stayed offline past the recovery window;
 * - `max_session`: the group reached its max session time;
 * - `replaced`: a newer connection resumed the same participant (only that
 *   older connection is told; the group goes on);
 * - `removed`: the participant is on the leader's block list.
 */
export type GroupEndedReason =
  'ended_by_leader' | 'leader_timeout' | 'max_session' | 'replaced' | 'removed';

/** Every GroupEndedReason, for schemas and exhaustive checks. */
export const GROUP_ENDED_REASONS = [
  'ended_by_leader',
  'leader_timeout',
  'max_session',
  'replaced',
  'removed',
] as const satisfies readonly GroupEndedReason[];

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export interface HelloMessage {
  type: 'hello';
  reqId?: string;
  protocolVersion: number;
  appVersion: string;
  /** Optional in the shape so that a missing key is reported as INVALID_API_KEY. */
  apiKey?: string;
}

export interface GroupCreateMessage {
  type: 'group.create';
  reqId?: string;
  /** Opaque group metadata; the server never reads its fields. */
  metadata: JsonObject;
  /** Optional opaque initial position. */
  position?: JsonValue;
  /**
   * The group's join methods (#10 AC5): a non-empty subset of the app's,
   * never both A and B. Omitted: the app's methods minus B when A is there.
   */
  joinMethods?: JoinMethod[];
}

export interface GroupJoinMessage {
  type: 'group.join';
  reqId?: string;
  groupId: string;
}

/**
 * Join by code (#10 AC12): a 6-digit group code (methods A, B) or an
 * 8-character alphanumeric code (method C), told apart by format after
 * normalization. Method A also needs the door code; without it the server
 * answers DOOR_CODE_REQUIRED. The display name is only relayed to the leader
 * of a method B group.
 */
export interface GroupJoinByCodeMessage {
  type: 'group.joinByCode';
  reqId?: string;
  joinCode: string;
  doorCode?: string;
  displayName?: string;
}

export interface PositionUpdateMessage {
  type: 'position.update';
  reqId?: string;
  /** Opaque position payload; the server never reads its fields. */
  position: JsonValue;
}

/**
 * Rejoin or recover a group with a participant token (#5 AC17, AC19, AC23).
 * A leader recreating a group that is not in memory must send its metadata,
 * and may send its latest position and block list. Item 4 adds the latest
 * join codes here (`joinCodes`); nothing reads them yet.
 */
export interface GroupResumeMessage {
  type: 'group.resume';
  reqId?: string;
  token: string;
  /** Opaque; required for a recreation, ignored when the group is live. */
  metadata?: JsonObject;
  /** Opaque; used only for a recreation (the live position wins, Q14). */
  position?: JsonValue;
  /** Leader only: blocked participant IDs. Omitted keeps the server's list (L5). */
  blockList?: string[];
}

/**
 * Asks which of the presented tokens' groups are live or resumable (#5
 * AC14). At most 20 tokens; one result per token, in the same order.
 */
export interface TokensCheckMessage {
  type: 'tokens.check';
  reqId?: string;
  tokens: string[];
}

/** The leader replaces its group's block list (#5 AC26, AC34). */
export interface BlockListSetMessage {
  type: 'blocklist.set';
  reqId?: string;
  blockList: string[];
}

/** The leader ends its group (#5 AC29). */
export interface GroupEndMessage {
  type: 'group.end';
  reqId?: string;
}

/** A member leaves its group (#5 AC30). */
export interface GroupLeaveMessage {
  type: 'group.leave';
  reqId?: string;
}

/**
 * The leader replaces every code of its group (#10 AC30): new group code,
 * door code and alphanumeric code as applicable. Older QR tickets stop
 * working, door-code failures reset and a pause is lifted. Reply:
 * `codes.updated` with reason `rotated`.
 */
export interface CodesRotateMessage {
  type: 'codes.rotate';
  reqId?: string;
}

/** The joiner withdraws its pending method B request (#10 AC21). Reply: `join.cancelled`. */
export interface JoinCancelMessage {
  type: 'join.cancel';
  reqId?: string;
}

/** The leader admits a pending joiner (#10 AC21). Reply: `join.decided`. */
export interface JoinApproveMessage {
  type: 'join.approve';
  reqId?: string;
  requestId: string;
}

/** The leader refuses a pending joiner (#10 AC21). Reply: `join.decided`. */
export interface JoinDenyMessage {
  type: 'join.deny';
  reqId?: string;
  requestId: string;
}

export type ClientMessage =
  | HelloMessage
  | GroupCreateMessage
  | GroupJoinMessage
  | GroupJoinByCodeMessage
  | PositionUpdateMessage
  | GroupResumeMessage
  | TokensCheckMessage
  | BlockListSetMessage
  | GroupEndMessage
  | GroupLeaveMessage
  | CodesRotateMessage
  | JoinCancelMessage
  | JoinApproveMessage
  | JoinDenyMessage;

export type ClientMessageType = ClientMessage['type'];

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

export interface WelcomeMessage {
  type: 'welcome';
  protocolVersion: number;
  minProtocolVersion: number;
}

export interface AppLimits {
  maxGroupSize: number;
  maxLeaderUpdatesPerSecond: number;
  maxMessageBytes: number;
  /** Max session time from group creation; clients prune stored tokens by it (#5 M6). */
  maxSessionMinutes: number;
  /** Lifetime of a QR ticket (#10 AC3, AC4). */
  qrTicketSeconds: number;
  /** How long a method B join request waits for the leader (#10 AC3, AC4). */
  approvalTimeoutSeconds: number;
}

export interface HelloOkMessage {
  type: 'hello.ok';
  reqId?: string;
  participantId: string;
  /** The app's namespace (not secret); clients key token storage by it (#5 AC33). */
  namespace: string;
  /** The join methods this app allows, canonical order (#10 AC4). */
  joinMethods: JoinMethod[];
  limits: AppLimits;
}

/**
 * A group's join codes, sent only to its leader (#10 AC6, AC10). Codes are
 * present only for the group's methods: a group code for A or B, a door
 * code for A, an alphanumeric code for C. The ticket generation is not on
 * the wire; it travels inside the signed blob only.
 */
export interface JoinCodesPayload {
  /** Code generation: increases on every code change (#10 AC6). */
  generation: number;
  groupCode?: string;
  doorCode?: string;
  alphaCode?: string;
  /** Server-signed copy of the codes for recovery after a restart (#10 AC32). */
  blob: string;
}

export interface GroupCreatedMessage {
  type: 'group.created';
  reqId?: string;
  groupId: string;
  participantId: string;
  role: 'leader';
  /** The leader's participant token for this group (#5 AC5). */
  token: string;
  /** The group's join methods, canonical order (#10 AC5). */
  joinMethods: JoinMethod[];
  /** The group's join codes (#10 AC6). */
  codes: JoinCodesPayload;
}

interface GroupJoinedBase {
  type: 'group.joined';
  reqId?: string;
  groupId: string;
  participantId: string;
  role: 'member';
  metadata: JsonObject;
  /** The member's participant token for this group (#5 AC5). */
  token: string;
  /** False while the leader is offline (frozen group, #5 AC18). */
  leaderOnline: boolean;
}

/** `hasPosition: false` (and no `position` field) is the explicit "no position yet". */
export type GroupJoinedMessage =
  | (GroupJoinedBase & { hasPosition: true; position: JsonValue })
  | (GroupJoinedBase & { hasPosition: false });

/** Reply to a leader's group.resume (#5 AC19, AC23). */
interface GroupResumedBase {
  type: 'group.resumed';
  reqId?: string;
  groupId: string;
  participantId: string;
  role: 'leader';
  metadata: JsonObject;
  /** A fresh leader token. */
  token: string;
  /** True when the group was rebuilt from the token (not in memory before). */
  recreated: boolean;
}

export type GroupResumedMessage =
  | (GroupResumedBase & { hasPosition: true; position: JsonValue })
  | (GroupResumedBase & { hasPosition: false });

/**
 * Reply to a member's group.resume when the group is not in memory: the
 * connection waits (parked) until the leader recreates it (#5 AC25).
 */
export interface GroupWaitingMessage {
  type: 'group.waiting';
  reqId?: string;
  groupId: string;
}

/** Status of a stored token (#5 AC14). */
export type TokenStatus =
  'live' | 'recoverable' | 'waiting' | 'blocked' | 'ended' | 'expired' | 'invalid';

/** Every TokenStatus, for schemas. */
export const TOKEN_STATUSES = [
  'live',
  'recoverable',
  'waiting',
  'blocked',
  'ended',
  'expired',
  'invalid',
] as const satisfies readonly TokenStatus[];

/**
 * One result per presented token, in order (#5 AC14). `token` is present
 * only for a usable token that was signed with the previous secret: the same
 * claims re-signed with the current secret (AC2).
 */
export interface TokensResultMessage {
  type: 'tokens.result';
  reqId?: string;
  results: Array<{ status: TokenStatus; token?: string }>;
}

export interface PositionAckMessage {
  type: 'position.ack';
  reqId?: string;
}

export interface PositionUpdatedMessage {
  type: 'position.updated';
  groupId: string;
  position: JsonValue;
}

export interface GroupEndedMessage {
  type: 'group.ended';
  /** Set only on the leader's reply to its own group.end. */
  reqId?: string;
  groupId: string;
  reason: GroupEndedReason;
}

/** Reply to blocklist.set. */
export interface BlockListAckMessage {
  type: 'blocklist.ack';
  reqId?: string;
}

/** Reply to group.leave (#5 AC30). */
export interface GroupLeftMessage {
  type: 'group.left';
  reqId?: string;
  groupId: string;
}

/** To the leader: a refreshed leader token with a new last-activity time (#5 AC12). */
export interface TokenRefreshedMessage {
  type: 'token.refreshed';
  groupId: string;
  token: string;
}

/** To attached members: the leader's connection closed; the group is frozen (#5 AC18). */
export interface LeaderOfflineMessage {
  type: 'leader.offline';
  groupId: string;
}

/** To attached members: the leader is back (#5 AC19). */
export interface LeaderOnlineMessage {
  type: 'leader.online';
  groupId: string;
}

/**
 * To the leader only: the group's codes changed (#10 AC29, AC30). The reply
 * to `codes.rotate` (reason `rotated`, with its reqId), or unsolicited after
 * repeated wrong door codes (reason `door_failures`).
 */
export interface CodesUpdatedMessage {
  type: 'codes.updated';
  reqId?: string;
  groupId: string;
  reason: CodesUpdatedReason;
  codes: JoinCodesPayload;
}

/** Why the codes changed: the leader rotated them, or the door code rotated after failures. */
export type CodesUpdatedReason = 'rotated' | 'door_failures';

/** To the leader: door-code joining paused after repeated failures (#10 AC29). */
export interface JoinPausedMessage {
  type: 'join.paused';
  groupId: string;
  retryAfterMs: number;
}

/** To the leader: door-code joining works again (#10 AC29, AC30). */
export interface JoinResumedMessage {
  type: 'join.resumed';
  groupId: string;
}

/**
 * To the joiner: the method B request waits for the leader (#10 AC19). No
 * group ID: the server does not reveal it before admission.
 */
export interface JoinPendingMessage {
  type: 'join.pending';
  reqId?: string;
  requestId: string;
  /** How long the request waits, from now (#10 D6). */
  timeoutMs: number;
}

/** To the leader: someone asks to join (#10 AC19); re-sent on leader return (AC34). */
export interface JoinRequestedMessage {
  type: 'join.requested';
  groupId: string;
  requestId: string;
  /** Remaining time before the request times out. */
  expiresInMs: number;
  /** The joiner's optional display name; render as text only. */
  displayName?: string;
}

/** Why a request left the leader's list without a decision. */
export type JoinWithdrawnReason = 'cancelled' | 'disconnected' | 'timeout';

/** To the leader: a request ended without a decision (#10 AC21). */
export interface JoinWithdrawnMessage {
  type: 'join.withdrawn';
  groupId: string;
  requestId: string;
  reason: JoinWithdrawnReason;
}

/** What happened to an approved or denied request. */
export type JoinDecision = 'admitted' | 'group_full' | 'denied';

/** To the leader: the reply to join.approve or join.deny (#10 AC21). */
export interface JoinDecidedMessage {
  type: 'join.decided';
  reqId?: string;
  requestId: string;
  outcome: JoinDecision;
}

/** To the joiner: the reply to join.cancel (#10 AC21). */
export interface JoinCancelledMessage {
  type: 'join.cancelled';
  reqId?: string;
  requestId: string;
}

export interface ErrorMessage {
  type: 'error';
  reqId?: string;
  code: ErrorCode;
  message: string;
  details?: Record<string, JsonValue>;
}

export type ServerMessage =
  | WelcomeMessage
  | HelloOkMessage
  | GroupCreatedMessage
  | GroupJoinedMessage
  | GroupResumedMessage
  | GroupWaitingMessage
  | TokensResultMessage
  | PositionAckMessage
  | PositionUpdatedMessage
  | GroupEndedMessage
  | GroupLeftMessage
  | BlockListAckMessage
  | TokenRefreshedMessage
  | LeaderOfflineMessage
  | LeaderOnlineMessage
  | CodesUpdatedMessage
  | JoinPausedMessage
  | JoinResumedMessage
  | JoinPendingMessage
  | JoinRequestedMessage
  | JoinWithdrawnMessage
  | JoinDecidedMessage
  | JoinCancelledMessage
  | ErrorMessage;

export type ServerMessageType = ServerMessage['type'];
