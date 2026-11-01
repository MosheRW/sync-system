import type { ErrorCode, ErrorMessage, JsonValue } from '@sync-system/protocol';

/**
 * Fixed human-readable text per code. Messages never include received
 * values, so the error for another app's group ID is byte-identical to the
 * one for a nonexistent ID (AC18).
 */
const ERROR_TEXT: Record<ErrorCode, string> = {
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
  NOT_LEADER: 'Only the leader can update the position',
  RATE_LIMITED: 'Too many position updates',
  MESSAGE_TOO_LARGE: 'Message too large',
  TOO_MANY_MESSAGES: 'Too many messages',
  INTERNAL_ERROR: 'Internal error',
  LEADER_CANNOT_LEAVE: 'The leader cannot leave; end the group instead',
  TOKEN_INVALID: 'Invalid token',
  TOKEN_EXPIRED: 'Token expired',
  GROUP_ENDED: 'Group has ended',
  PARTICIPANT_BLOCKED: 'Participant is blocked',
};

export function errorMessage(
  code: ErrorCode,
  options: { reqId?: string | undefined; details?: Record<string, JsonValue> | undefined } = {},
): ErrorMessage {
  const message: ErrorMessage = { type: 'error', code, message: ERROR_TEXT[code] };
  if (options.reqId !== undefined) message.reqId = options.reqId;
  if (options.details !== undefined) message.details = options.details;
  return message;
}
