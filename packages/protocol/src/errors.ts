/**
 * Error codes sent in `error` messages. Clients branch on these, never on the
 * human-readable `message`.
 */
export const ErrorCode = {
  /** Bad JSON, binary frame, schema failure or nesting deeper than allowed. */
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  /** A non-hello message arrived before `hello.ok`. */
  HANDSHAKE_REQUIRED: 'HANDSHAKE_REQUIRED',
  /** No hello arrived within the handshake timeout. */
  HANDSHAKE_TIMEOUT: 'HANDSHAKE_TIMEOUT',
  /** A second hello on an authenticated connection. */
  ALREADY_AUTHENTICATED: 'ALREADY_AUTHENTICATED',
  /** Missing or unknown API key. */
  INVALID_API_KEY: 'INVALID_API_KEY',
  /** Client protocol version is below the server minimum. */
  PROTOCOL_TOO_OLD: 'PROTOCOL_TOO_OLD',
  /** Client app version is not valid semver. */
  INVALID_APP_VERSION: 'INVALID_APP_VERSION',
  /** Client app version is below the app's configured minimum. */
  APP_VERSION_TOO_OLD: 'APP_VERSION_TOO_OLD',
  /** The app already has its maximum number of connections. */
  APP_CONNECTION_LIMIT: 'APP_CONNECTION_LIMIT',
  /** Unknown, malformed or other app's group ID. */
  GROUP_NOT_FOUND: 'GROUP_NOT_FOUND',
  /** Joining would exceed the group's maximum size. */
  GROUP_FULL: 'GROUP_FULL',
  /** Create or join while already in a group. */
  ALREADY_IN_GROUP: 'ALREADY_IN_GROUP',
  /** Position update while not in a group. */
  NOT_IN_GROUP: 'NOT_IN_GROUP',
  /** A member (not the leader) sent a position update. */
  NOT_LEADER: 'NOT_LEADER',
  /** The leader exceeded its position update rate. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Position payload or metadata exceeds the app's size limit. */
  MESSAGE_TOO_LARGE: 'MESSAGE_TOO_LARGE',
  /** The connection exceeded its inbound message limit; it is closed. */
  TOO_MANY_MESSAGES: 'TOO_MANY_MESSAGES',
  /** An unexpected server error while handling a message. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
