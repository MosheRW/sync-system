import type { ErrorCode, ErrorMessage, JsonValue } from '@sync-system/protocol';

/**
 * Codes that more than one action can return. Each action has its own text
 * (#7 A1, D4), so these codes are only sent through actionErrorMessage().
 */
export type ActionErrorCode = 'RATE_LIMITED' | 'NOT_LEADER' | 'NOT_ALLOWED';

/** Codes with one fixed text, sent through errorMessage(). */
export type GenericErrorCode = Exclude<ErrorCode, ActionErrorCode>;

/**
 * Fixed text per code and action (#7 A1). Like ERROR_TEXT, a text never
 * includes a received value (AC18 from #1, #7 AC20).
 */
export const ACTION_ERROR_TEXT = {
  RATE_LIMITED: {
    'group.create': 'Too many groups created; try later',
    'position.update': 'Too many position updates',
    'tokens.check': 'Too many token checks',
    'group.joinByCode': 'Too many join attempts',
    'codes.rotate': 'Too many code rotations',
    'group.joinByQr': 'Too many join attempts',
    'qr.issue': 'Too many QR code requests',
    'group.resume': 'Too many group recoveries',
    'vice.set': 'Too many vice-leader changes',
    'vice.clear': 'Too many vice-leader clears',
    'group.lock': 'Too many group locks',
    'group.unlock': 'Too many group unlocks',
    'member.remove': 'Too many member removals',
    'leader.activity': 'Too many leader activity signals',
    'keepalive.ack': 'Too many keep-alive answers',
    'leader.takeBack': 'Too many take-backs',
  },
  NOT_LEADER: {
    'position.update': 'Only the leader can update the position',
    'group.end': 'Only the leader can end the group',
    'blocklist.set': 'Only the leader can set the block list',
    'codes.rotate': 'Only the leader can rotate the codes',
    'join.approve': 'Only the leader can approve join requests',
    'join.deny': 'Only the leader can deny join requests',
    'qr.issue': 'Only the leader can issue QR codes',
    'vice.set': 'Only the leader can choose the vice-leader',
    'vice.clear': 'Only the leader can clear the vice-leader',
    'group.lock': 'Only the leader can lock the group',
    'group.unlock': 'Only the leader can unlock the group',
    'member.remove': 'Only the leader can remove members',
    'leader.activity': 'Only the leader can send leader activity',
    'keepalive.ack': 'Only the leader can answer the keep-alive',
  },
  NOT_ALLOWED: {
    'vice.set': 'This participant cannot be the vice-leader now',
    'member.remove': 'This participant cannot be removed',
    'leader.takeBack': 'Only the displaced leader can take back the lead',
  },
} as const satisfies Record<ActionErrorCode, Record<string, string>>;

export type ErrorAction<C extends ActionErrorCode> = keyof (typeof ACTION_ERROR_TEXT)[C];

/**
 * Fixed human-readable text per code. Messages never include received
 * values, so the error for another app's group ID is byte-identical to the
 * one for a nonexistent ID (AC18).
 */
export const ERROR_TEXT: Record<GenericErrorCode, string> = {
  INVALID_MESSAGE: 'Invalid message',
  HANDSHAKE_REQUIRED: 'Send hello before any other message',
  HANDSHAKE_TIMEOUT: 'No hello received in time',
  ALREADY_AUTHENTICATED: 'Already authenticated',
  INVALID_API_KEY: 'Unknown or missing API key',
  PROTOCOL_TOO_OLD: 'Client protocol version is too old',
  INVALID_APP_VERSION: 'App version must be valid semver',
  APP_VERSION_TOO_OLD: 'App version is too old; please update',
  APP_CONNECTION_LIMIT: 'App connection limit reached; try again later',
  GROUP_NOT_FOUND: 'Group not found',
  GROUP_FULL: 'Group is full',
  ALREADY_IN_GROUP: 'Already in a group',
  NOT_IN_GROUP: 'Not in a group',
  MESSAGE_TOO_LARGE: 'Message too large',
  TOO_MANY_MESSAGES: 'Too many messages',
  INTERNAL_ERROR: 'Internal error',
  LEADER_CANNOT_LEAVE: 'The leader cannot leave; end the group instead',
  TOKEN_INVALID: 'Invalid token',
  TOKEN_EXPIRED: 'Token expired',
  GROUP_ENDED: 'Group has ended',
  PARTICIPANT_BLOCKED: 'Participant is blocked',
  JOIN_METHOD_NOT_ALLOWED: 'Join method not allowed',
  CODES_EXHAUSTED: 'No free join code; try again',
  CODE_NOT_FOUND: 'Join code not found',
  DOOR_CODE_REQUIRED: 'Door code required',
  DOOR_CODE_WRONG: 'Wrong door code',
  JOIN_PAUSED: 'Joining with the door code is paused; try again later',
  JOIN_DENIED: 'The leader denied the join request',
  APPROVAL_TIMEOUT: 'The join request was not approved in time',
  APPROVAL_QUEUE_FULL: 'Too many pending join requests for this group',
  JOIN_REQUEST_NOT_FOUND: 'Join request not found',
  QR_INVALID: 'Invalid QR code',
  QR_EXPIRED: 'QR code expired',
  PARTICIPANT_NOT_FOUND: 'Participant not found',
  GROUP_LOCKED: 'Group is locked',
  BLOCK_LIST_FULL: 'Block list is full',
  APP_GROUP_LIMIT: 'The app has too many live groups; try later',
};

interface ErrorOptions {
  reqId?: string | undefined;
  details?: Record<string, JsonValue> | undefined;
}

function build(code: ErrorCode, text: string, options: ErrorOptions): ErrorMessage {
  const message: ErrorMessage = { type: 'error', code, message: text };
  if (options.reqId !== undefined) message.reqId = options.reqId;
  if (options.details !== undefined) message.details = options.details;
  return message;
}

export function errorMessage(code: GenericErrorCode, options: ErrorOptions = {}): ErrorMessage {
  return build(code, ERROR_TEXT[code], options);
}

/** An error for a code several actions share; the text names `action` (#7 A1). */
export function actionErrorMessage<C extends ActionErrorCode>(
  code: C,
  action: ErrorAction<C>,
  options: ErrorOptions = {},
): ErrorMessage {
  const texts: Record<PropertyKey, string> = ACTION_ERROR_TEXT[code];
  return build(code, texts[action], options);
}
