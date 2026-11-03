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
  /** The leader sent group.leave; it must end the group instead (#5 Q-D). */
  LEADER_CANNOT_LEAVE: 'LEADER_CANNOT_LEAVE',
  /**
   * The token is not valid here: bad signature or shape, another app's
   * token, an unknown format version or an expired `exp`. The same bytes for
   * every cause (#5 AC7, AC8, AC15).
   */
  TOKEN_INVALID: 'TOKEN_INVALID',
  /** The token is past the group's max session time or recovery window (#5 AC9). */
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  /** The token's group ended in this server's lifetime (#5 AC27, AC29). */
  GROUP_ENDED: 'GROUP_ENDED',
  /** The participant is on the leader's block list (#5 AC17, AC26). */
  PARTICIPANT_BLOCKED: 'PARTICIPANT_BLOCKED',
  /**
   * A join method set the app does not allow at group.create, or a QR
   * ticket requested for a group without method D (#10 AC5, AC23).
   */
  JOIN_METHOD_NOT_ALLOWED: 'JOIN_METHOD_NOT_ALLOWED',
  /** No free join code was found; nothing was created (#10 AC9). */
  CODES_EXHAUSTED: 'CODES_EXHAUSTED',
  /**
   * The code matches no live group of this app, or a group that does not
   * use that code type. One answer for every cause (#10 AC13).
   */
  CODE_NOT_FOUND: 'CODE_NOT_FOUND',
  /** A method A group code without a door code; not counted as a failure (#10 AC15). */
  DOOR_CODE_REQUIRED: 'DOOR_CODE_REQUIRED',
  /** A wrong door code; counted as a door-code failure (#10 AC15). */
  DOOR_CODE_WRONG: 'DOOR_CODE_WRONG',
  /**
   * Door-code joining for this group is paused after repeated door-code
   * failures; `details.retryAfterMs` (#10 AC29).
   */
  JOIN_PAUSED: 'JOIN_PAUSED',
  /** The leader denied the method B join request (#10 AC21). */
  JOIN_DENIED: 'JOIN_DENIED',
  /** The leader did not decide within approvalTimeoutSeconds (#10 AC21). */
  APPROVAL_TIMEOUT: 'APPROVAL_TIMEOUT',
  /** The group already has 10 pending join requests; `details.maxPending` (#10 AC22). */
  APPROVAL_QUEUE_FULL: 'APPROVAL_QUEUE_FULL',
  /** Approve, deny or cancel of an unknown or already settled request (#10 AC21). */
  JOIN_REQUEST_NOT_FOUND: 'JOIN_REQUEST_NOT_FOUND',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
