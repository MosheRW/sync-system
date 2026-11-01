import type { ErrorCode } from './errors.js';
import type { JsonObject, JsonValue } from './json.js';

/** Role of a participant in a group. Later issues add more roles. */
export type Role = 'leader' | 'member';

/** Why a group ended. Later issues add more reasons. */
export type GroupEndedReason = 'leader_disconnected';

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
}

export interface GroupJoinMessage {
  type: 'group.join';
  reqId?: string;
  groupId: string;
}

export interface PositionUpdateMessage {
  type: 'position.update';
  reqId?: string;
  /** Opaque position payload; the server never reads its fields. */
  position: JsonValue;
}

export type ClientMessage =
  HelloMessage | GroupCreateMessage | GroupJoinMessage | PositionUpdateMessage;

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
}

export interface HelloOkMessage {
  type: 'hello.ok';
  reqId?: string;
  participantId: string;
  /** The app's namespace (not secret); clients key token storage by it (#5 AC33). */
  namespace: string;
  limits: AppLimits;
}

export interface GroupCreatedMessage {
  type: 'group.created';
  reqId?: string;
  groupId: string;
  participantId: string;
  role: 'leader';
  /** The leader's participant token for this group (#5 AC5). */
  token: string;
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
  groupId: string;
  reason: GroupEndedReason;
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
  | PositionAckMessage
  | PositionUpdatedMessage
  | GroupEndedMessage
  | ErrorMessage;

export type ServerMessageType = ServerMessage['type'];
