import type { ErrorCode } from './errors.js';
import type { JoinMethod } from './join.js';
import type { JsonObject, JsonValue } from './json.js';
import type { HandoffMode } from './limits.js';

/**
 * Role of a participant in a group (#13 AC5). At most one vice-leader; it has
 * no leader powers until it leads (AC7) and holds a member token (Q3.1).
 */
export type Role = 'leader' | 'vice-leader' | 'member';

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
  /** The group's handoff mode (#13 AC3); omitted: the app's `defaultHandoff`. */
  handoff?: HandoffMode;
  /** The creator's display name (#13 AC35); missing or blank: a generated one. */
  displayName?: string;
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
 * and may send its latest position and block list, and the latest signed
 * codes blob it received (`joinCodes`, #10 AC32).
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
  /**
   * Leader only: the latest signed codes blob (#10 AC32, AC33). Used to keep
   * the same codes when the group is recreated; the server accepts only
   * codes it signed for this group.
   */
  joinCodes?: string;
  /** Leader recovery state (#13 D13): the group's handoff mode, used for a recreation. */
  handoff?: HandoffMode;
  /**
   * Leader recovery state (#13 D13, AC13): the vice-leader, used for a
   * recreation; ignored unless that participant rejoins and is not blocked.
   */
  viceId?: string;
  /** Leader recovery state (#13 D13, Q4.3): the lock flag, used for a recreation. */
  locked?: boolean;
  /**
   * The participant's display name, sent again on every resume (#13 AC37,
   * Q5.4). Used when the participant gets a new roster entry (after a
   * restart or an eviction); missing or blank: a generated one. An existing
   * entry keeps its name (no renaming, Q5.3).
   */
  displayName?: string;
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

/** The leader of a method D group asks for a QR ticket (#10 AC23). Reply: `qr.ticket`. */
export interface QrIssueMessage {
  type: 'qr.issue';
  reqId?: string;
}

/**
 * Join with a QR ticket (#10 AC24). In a method B group the joiner still
 * needs the leader's approval (Q3.2), so a display name is allowed here too.
 */
export interface GroupJoinByQrMessage {
  type: 'group.joinByQr';
  reqId?: string;
  ticket: string;
  displayName?: string;
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

/** The leader designates a present member as vice-leader (#13 AC10). Reply: `vice.updated`. */
export interface ViceSetMessage {
  type: 'vice.set';
  reqId?: string;
  participantId: string;
}

/** The leader clears the vice-leader (#13 AC10). Reply: `vice.updated`. */
export interface ViceClearMessage {
  type: 'vice.clear';
  reqId?: string;
}

/** The leader stops all new joining (#13 AC29). Idempotent. Reply: `lock.changed`. */
export interface GroupLockMessage {
  type: 'group.lock';
  reqId?: string;
}

/** The leader allows joining again (#13 AC29). Idempotent. Reply: `lock.changed`. */
export interface GroupUnlockMessage {
  type: 'group.unlock';
  reqId?: string;
}

/**
 * The leader removes a participant (#13 AC32): it is blocked for the rest of
 * the session, its connection is closed and every code rotates. Reply:
 * `member.removed`, then `codes.updated` (reason `member_removed`).
 */
export interface MemberRemoveMessage {
  type: 'member.remove';
  reqId?: string;
  participantId: string;
}

/**
 * The leader is active without moving the group, e.g. while previewing
 * (#13 AC30). No payload: a previewed position never reaches the server.
 * Reply: `activity.ack`.
 */
export interface LeaderActivityMessage {
  type: 'leader.activity';
  reqId?: string;
}

/** The leader answers a keep-alive prompt (#13 AC16). Reply: `activity.ack`. */
export interface KeepAliveAckMessage {
  type: 'keepalive.ack';
  reqId?: string;
}

export type ClientMessage =
  | HelloMessage
  | GroupCreateMessage
  | GroupJoinByCodeMessage
  | GroupJoinByQrMessage
  | QrIssueMessage
  | PositionUpdateMessage
  | GroupResumeMessage
  | TokensCheckMessage
  | BlockListSetMessage
  | GroupEndMessage
  | GroupLeaveMessage
  | CodesRotateMessage
  | JoinCancelMessage
  | JoinApproveMessage
  | JoinDenyMessage
  | ViceSetMessage
  | ViceClearMessage
  | GroupLockMessage
  | GroupUnlockMessage
  | MemberRemoveMessage
  | LeaderActivityMessage
  | KeepAliveAckMessage;

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
  /** Leader inactivity before the group pauses (#5 AC4, #13 AC15). */
  inactivityLimitMinutes: number;
  /** Grace period after the leader disconnects or misses a keep-alive (#13 AC1). */
  disconnectGraceSeconds: number;
  /** Keep-alive countdown before the inactivity limit (#13 AC1, AC16). */
  keepAliveCountdownSeconds: number;
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
  /** The handoff mode of a group created without one (#13 AC3). */
  defaultHandoff: HandoffMode;
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

/** The receiver's own name in the group (#13 AC36). */
interface OwnName {
  /** Chosen (strict #10 rule) or generated `Guest N`. Render as text only. */
  displayName: string;
  /** True for a generated name, so apps can localize it (Q5.1). */
  generated: boolean;
}

export interface GroupCreatedMessage extends OwnName {
  type: 'group.created';
  reqId?: string;
  groupId: string;
  participantId: string;
  role: 'leader';
  /** The group's handoff mode (#13 AC3). */
  handoff: HandoffMode;
  /** The leader recovery state (#13 D13). */
  state: LeaderState;
  /** The leader's participant token for this group (#5 AC5). */
  token: string;
  /** The group's join methods, canonical order (#10 AC5). */
  joinMethods: JoinMethod[];
  /** The group's join codes (#10 AC6). */
  codes: JoinCodesPayload;
}

interface GroupJoinedBase extends OwnName {
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
  /** The leader locked the group: nobody new joins (#13 AC29). */
  locked: boolean;
  /** The group is paused: why, and the grace left (#13 D8). `leaderOnline` is false. */
  leaderPause?: LeaderPause;
}

/** `hasPosition: false` (and no `position` field) is the explicit "no position yet". */
export type GroupJoinedMessage =
  | (GroupJoinedBase & { hasPosition: true; position: JsonValue })
  | (GroupJoinedBase & { hasPosition: false });

/** Reply to a leader's group.resume (#5 AC19, AC23). */
interface GroupResumedBase extends OwnName {
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
  /** The group's join methods (#10). */
  joinMethods: JoinMethod[];
  /** The group's current codes and a fresh blob (#10 AC33, AC34). */
  codes: JoinCodesPayload;
  /**
   * False only when the presented blob is the group's current one (same code
   * generation): the codes the leader already has still hold (#10 AC33).
   */
  codesChanged: boolean;
  /** The leader recovery state, the server's (#13 D13). */
  state: LeaderState;
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

/**
 * Why the group is paused (#13 D8): the leader's connection closed, or it
 * missed the keep-alive while connected.
 */
export type LeaderPauseCause = 'disconnected' | 'inactive';

/** A running pause as members see it (#13 D8, D12). */
export interface LeaderPause {
  cause: LeaderPauseCause;
  /**
   * Time left before the lead passes on (a duration, never a clock time).
   * Present only when a handoff can follow (`auto` mode).
   */
  graceMs?: number;
}

/**
 * To attached members: the group is paused (frozen, #5 AC18, #13 AC14,
 * AC17). `cause` and `graceMs` are new in #13; older servers sent neither.
 */
export interface LeaderOfflineMessage {
  type: 'leader.offline';
  groupId: string;
  cause?: LeaderPauseCause;
  graceMs?: number;
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

/**
 * Why the codes changed: the leader rotated them, the door code rotated
 * after failures, or a removal rotated every code (#13 Q4.1).
 */
export type CodesUpdatedReason = 'rotated' | 'door_failures' | 'member_removed';

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

/**
 * To the leader: the reply to qr.issue (#10 AC23). The ticket is an opaque,
 * URL-safe bearer credential of at most 256 characters; it admits any
 * number of joiners until it expires.
 */
export interface QrTicketMessage {
  type: 'qr.ticket';
  reqId?: string;
  ticket: string;
  /** Lifetime from now: `qrTicketSeconds * 1000` (#10 D6). */
  expiresInMs: number;
}

/** To the joiner: the reply to join.cancel (#10 AC21). */
export interface JoinCancelledMessage {
  type: 'join.cancelled';
  reqId?: string;
  requestId: string;
}

/**
 * One roster entry, sent to the leader only (#13 AC31, Q4.4). Durations,
 * never clock times (D12). Names are plain text: render, never interpret.
 */
export interface RosterEntryWire {
  participantId: string;
  displayName: string;
  generated: boolean;
  /** The N of a generated `Guest N`. */
  guestNumber?: number;
  role: Role;
  connected: boolean;
  /** Time since admission, ms. */
  joinedAgoMs: number;
  /**
   * Admitted by code, QR or approval after a restart, before the real
   * leader superseded a stale one (#13 6.6.4); shown only after a supersede.
   */
  admittedSinceRecovery?: true;
}

/** To the leader: the whole roster, after created, resumed or granted (#13 AC31). */
export interface RosterSnapshotMessage {
  type: 'roster.snapshot';
  groupId: string;
  participants: RosterEntryWire[];
}

/** To the leader: one entry joined, reconnected, disconnected or changed role (#13 AC31). */
export interface RosterUpdatedMessage {
  type: 'roster.updated';
  groupId: string;
  participant: RosterEntryWire;
}

/**
 * What the leader's client keeps with its token to recover the group after
 * a restart (#13 D13, decision 3): the block list, the lock flag, the
 * vice-leader and the handoff mode. Sent to every leader.
 */
export interface LeaderState {
  blockList: string[];
  locked: boolean;
  viceId?: string;
  handoff: HandoffMode;
}

/** The reply to group.lock / group.unlock, and to members a change of it (#13 AC29). */
export interface LockChangedMessage {
  type: 'lock.changed';
  reqId?: string;
  groupId: string;
  locked: boolean;
}

/** To the leader: the reply to member.remove, with the full block list to keep (#13 AC32). */
export interface MemberRemovedMessage {
  type: 'member.removed';
  reqId?: string;
  groupId: string;
  participantId: string;
  blockList: string[];
}

/** To the leader: the reply to leader.activity and keepalive.ack (#13 AC16, AC30). */
export interface ActivityAckMessage {
  type: 'activity.ack';
  reqId?: string;
}

/**
 * To the leader: no counted activity for a while; answer within
 * `countdownMs` (a duration, never a clock time, D12) or the group pauses
 * (#13 AC16, AC17). Members never get it.
 */
export interface KeepAlivePromptMessage {
  type: 'keepalive.prompt';
  groupId: string;
  countdownMs: number;
}

/** To the leader: an activity answered the prompt (#13 AC16). */
export interface KeepAliveClearedMessage {
  type: 'keepalive.cleared';
  groupId: string;
}

/** To the leader: the reply to vice.set / vice.clear (#13 AC10). */
export interface ViceUpdatedMessage {
  type: 'vice.updated';
  reqId?: string;
  groupId: string;
  /** The vice-leader now, or null. */
  viceId: string | null;
}

/**
 * To a participant: it became, or is no longer, the vice-leader (#13 AC11).
 * Re-sent when the vice rejoins. Nobody else is told (Q3.3).
 */
export interface ViceChangedMessage {
  type: 'vice.changed';
  groupId: string;
  isVice: boolean;
}

/** To the leader: an entry left the roster (leave, removal, eviction; #13 AC31). */
export interface RosterRemovedMessage {
  type: 'roster.removed';
  groupId: string;
  participantId: string;
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
  | QrTicketMessage
  | RosterSnapshotMessage
  | RosterUpdatedMessage
  | RosterRemovedMessage
  | ViceUpdatedMessage
  | ViceChangedMessage
  | LockChangedMessage
  | MemberRemovedMessage
  | ActivityAckMessage
  | KeepAlivePromptMessage
  | KeepAliveClearedMessage
  | ErrorMessage;

export type ServerMessageType = ServerMessage['type'];
