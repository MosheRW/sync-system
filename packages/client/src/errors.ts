import { type AppLimits, ErrorCode, type ErrorMessage } from '@sync-system/protocol';

/**
 * Every code a `SyncClientError` can carry: the protocol's server codes plus
 * the codes the client produces itself.
 */
export const ClientErrorCode = {
  ...ErrorCode,
  /** A group call was made while not `connected` (AC11). */
  NOT_CONNECTED: 'NOT_CONNECTED',
  /** The app called `close()`. */
  CLOSED: 'CLOSED',
  /** The socket dropped, failed to open, or reported an error. */
  CONNECTION_LOST: 'CONNECTION_LOST',
  /** No reply in time (handshake, create, join or position ack). */
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
  /** `reconnect.maxAttempts` was used up. */
  RECONNECT_FAILED: 'RECONNECT_FAILED',
  /** The server's protocol versions or limits are not supported by this client (AC12). */
  SERVER_UNSUPPORTED: 'SERVER_UNSUPPORTED',
  /** The server closed the handshake with 4001 and no error frame. */
  HANDSHAKE_REJECTED: 'HANDSHAKE_REJECTED',
  /** No global WebSocket and none injected (AC6). */
  NO_WEBSOCKET: 'NO_WEBSOCKET',
  /** A constructor option is missing or invalid. */
  INVALID_OPTIONS: 'INVALID_OPTIONS',
  /** Metadata, position or group ID is not valid JSON input for the protocol. */
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  /** The server sent a frame that failed validation (AC10). */
  INVALID_SERVER_MESSAGE: 'INVALID_SERVER_MESSAGE',
  /** A group create or join is already in flight (L5). */
  REQUEST_IN_PROGRESS: 'REQUEST_IN_PROGRESS',
  /** No stored token for that group on this server and app (#5 AC38). */
  TOKEN_NOT_FOUND: 'TOKEN_NOT_FOUND',
  /** The block list would hold more than 256 participant IDs (#5 AC34). */
  BLOCK_LIST_FULL: 'BLOCK_LIST_FULL',
} as const;

export type ClientErrorCode = (typeof ClientErrorCode)[keyof typeof ClientErrorCode];

/** Which request an error belongs to, if any. */
export type RequestKind =
  | 'hello'
  | 'group.create'
  | 'group.join'
  | 'position.update'
  | 'group.resume'
  | 'tokens.check'
  | 'group.end'
  | 'group.leave'
  | 'blocklist.set';

interface KnownDetails {
  PROTOCOL_TOO_OLD: { minProtocolVersion?: number };
  APP_VERSION_TOO_OLD: { minAppVersion?: string };
  SERVER_UNSUPPORTED: {
    clientProtocolVersion: number;
    minServerProtocolVersion: number;
    serverProtocolVersion: number;
    serverMinProtocolVersion: number;
    /** Set when a `hello.ok` limit is outside the client's bounds (R2-L2). */
    limit?: keyof AppLimits;
  };
  MESSAGE_TOO_LARGE: { field?: 'position' | 'metadata'; limitBytes?: number; sizeBytes?: number };
  RATE_LIMITED: { maxLeaderUpdatesPerSecond?: number; retryAfterMs?: number };
  GROUP_FULL: { maxGroupSize?: number };
  INVALID_SERVER_MESSAGE: { issues: string[] };
  INVALID_OPTIONS: { field: string };
  BLOCK_LIST_FULL: { limit: number };
}

/** Typed `details` per code; `undefined` for codes without details. */
export type ErrorDetailsMap = {
  [C in ClientErrorCode]: C extends keyof KnownDetails ? KnownDetails[C] : undefined;
};

/** Fixed text per code. Never includes received values (L2, L3). */
const MESSAGES: Record<ClientErrorCode, string> = {
  INVALID_MESSAGE: 'The server rejected a message as invalid',
  HANDSHAKE_REQUIRED: 'The server required a handshake first',
  HANDSHAKE_TIMEOUT: 'The handshake timed out on the server',
  ALREADY_AUTHENTICATED: 'The server reported the connection as already authenticated',
  INVALID_API_KEY: 'Unknown or missing API key',
  PROTOCOL_TOO_OLD: 'This client protocol version is too old for the server',
  INVALID_APP_VERSION: 'The app version must be valid semver',
  APP_VERSION_TOO_OLD: 'This app version is too old; please update',
  APP_CONNECTION_LIMIT: 'The app reached its connection limit',
  GROUP_NOT_FOUND: 'Group not found',
  GROUP_FULL: 'Group is full',
  ALREADY_IN_GROUP: 'Already in a group',
  NOT_IN_GROUP: 'Not in a group',
  NOT_LEADER: 'Only the leader can update the position',
  RATE_LIMITED: 'Too many position updates',
  MESSAGE_TOO_LARGE: 'Message too large',
  TOO_MANY_MESSAGES: 'Too many messages',
  INTERNAL_ERROR: 'Internal server error',
  LEADER_CANNOT_LEAVE: 'The leader cannot leave the group; end it instead',
  TOKEN_INVALID: 'The stored token is not valid on this server',
  TOKEN_EXPIRED: 'The stored token has expired',
  GROUP_ENDED: 'The group has ended',
  PARTICIPANT_BLOCKED: 'The leader blocked this participant',
  NOT_CONNECTED: 'Not connected',
  CLOSED: 'The client was closed',
  CONNECTION_LOST: 'The connection was lost',
  REQUEST_TIMEOUT: 'The request timed out',
  RECONNECT_FAILED: 'Gave up reconnecting',
  SERVER_UNSUPPORTED: 'The server is not supported by this client',
  HANDSHAKE_REJECTED: 'The server rejected the handshake',
  NO_WEBSOCKET: 'No WebSocket implementation is available; pass one in the WebSocket option',
  INVALID_OPTIONS: 'Invalid client options',
  INVALID_PAYLOAD: 'The value is not a valid JSON payload',
  INVALID_SERVER_MESSAGE: 'The server sent an invalid message',
  REQUEST_IN_PROGRESS: 'A group request is already in progress',
  TOKEN_NOT_FOUND: 'No stored token for this group',
  BLOCK_LIST_FULL: 'The block list is full',
};

/**
 * Per-request text for codes several requests share, matching the server's
 * per-action texts (#7 A1). `MESSAGES` keeps the position-update text as the
 * default when the request is not known.
 */
export const ACTION_MESSAGES: {
  readonly [C in 'RATE_LIMITED' | 'NOT_LEADER']: Partial<Record<RequestKind, string>>;
} = {
  RATE_LIMITED: {
    'position.update': 'Too many position updates',
    'tokens.check': 'Too many token checks',
  },
  NOT_LEADER: {
    'position.update': 'Only the leader can update the position',
    'group.end': 'Only the leader can end the group',
    'blocklist.set': 'Only the leader can set the block list',
  },
};

/** The fixed text for `code`, named after `request` when the code is shared (#7 A1). */
function messageFor(code: ClientErrorCode, request: RequestKind | undefined): string {
  if ((code === 'RATE_LIMITED' || code === 'NOT_LEADER') && request !== undefined) {
    const text = ACTION_MESSAGES[code][request];
    if (text !== undefined) return text;
  }
  return MESSAGES[code];
}

/** Longest server `message` text kept in `serverMessage` (L2). */
export const MAX_SERVER_MESSAGE_LENGTH = 256;
/** Most schema issues kept in INVALID_SERVER_MESSAGE details (L2). */
export const MAX_ISSUES = 10;
/** Longest single schema issue text kept. */
export const MAX_ISSUE_LENGTH = 128;
/** Longest string kept from server `details` (L1). */
export const MAX_DETAIL_STRING_LENGTH = 64;

export interface SyncClientErrorInit<C extends ClientErrorCode> {
  details?: ErrorDetailsMap[C];
  source?: 'client' | 'server';
  fatal?: boolean;
  request?: RequestKind;
  serverMessage?: string;
}

/**
 * Every error the client reports. It never holds a raw frame, a payload, a
 * group ID or the API key, so it is safe to send to an error reporter (L3).
 */
export class SyncClientError<C extends ClientErrorCode = ClientErrorCode> extends Error {
  override readonly name = 'SyncClientError';
  readonly code: C;
  readonly source: 'client' | 'server';
  readonly fatal: boolean;
  readonly details: ErrorDetailsMap[C];
  readonly request?: RequestKind;
  /** The server's `message` text, cut to 256 characters. Untrusted: never render it as HTML. */
  readonly serverMessage?: string;

  constructor(code: C, init: SyncClientErrorInit<C> = {}) {
    super(messageFor(code, init.request));
    this.code = code;
    this.source = init.source ?? 'client';
    this.fatal = init.fatal ?? false;
    this.details = init.details as ErrorDetailsMap[C];
    if (init.request !== undefined) this.request = init.request;
    if (init.serverMessage !== undefined) this.serverMessage = init.serverMessage;
  }
}

/** True if `value` is a `SyncClientError`, optionally with the given code. */
export function isSyncClientError<C extends ClientErrorCode>(
  value: unknown,
  code?: C,
): value is SyncClientError<C> {
  return value instanceof SyncClientError && (code === undefined || value.code === code);
}

/**
 * Codes that end the client during the handshake (Q4, Q-A): the same hello
 * always gets the same answer, so retrying would loop.
 */
export const FATAL_HANDSHAKE_CODES: ReadonlySet<ClientErrorCode> = new Set<ClientErrorCode>([
  ErrorCode.INVALID_API_KEY,
  ErrorCode.INVALID_APP_VERSION,
  ErrorCode.PROTOCOL_TOO_OLD,
  ErrorCode.APP_VERSION_TOO_OLD,
  ErrorCode.INVALID_MESSAGE,
  ErrorCode.HANDSHAKE_REQUIRED,
  ErrorCode.ALREADY_AUTHENTICATED,
]);

type Details = Record<string, unknown> | undefined;

/** A finite, non-negative own number property of server details, else undefined (M1, L1). */
export function readDetailNumber(details: Details, key: string): number | undefined {
  if (details === undefined || !Object.hasOwn(details, key)) return undefined;
  const value = details[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readDetailString(details: Details, key: string): string | undefined {
  if (details === undefined || !Object.hasOwn(details, key)) return undefined;
  const value = details[key];
  return typeof value === 'string' ? value.slice(0, MAX_DETAIL_STRING_LENGTH) : undefined;
}

/** Builds a fresh, fixed-key details object for a server error code. */
function serverDetails(code: ErrorCode, raw: Details): unknown {
  switch (code) {
    case 'PROTOCOL_TOO_OLD': {
      const out: KnownDetails['PROTOCOL_TOO_OLD'] = {};
      const minProtocolVersion = readDetailNumber(raw, 'minProtocolVersion');
      if (minProtocolVersion !== undefined) out.minProtocolVersion = minProtocolVersion;
      return out;
    }
    case 'APP_VERSION_TOO_OLD': {
      const out: KnownDetails['APP_VERSION_TOO_OLD'] = {};
      const minAppVersion = readDetailString(raw, 'minAppVersion');
      if (minAppVersion !== undefined) out.minAppVersion = minAppVersion;
      return out;
    }
    case 'MESSAGE_TOO_LARGE': {
      const out: KnownDetails['MESSAGE_TOO_LARGE'] = {};
      const field = readDetailString(raw, 'field');
      if (field === 'position' || field === 'metadata') out.field = field;
      const limitBytes = readDetailNumber(raw, 'limitBytes');
      if (limitBytes !== undefined) out.limitBytes = limitBytes;
      const sizeBytes = readDetailNumber(raw, 'sizeBytes');
      if (sizeBytes !== undefined) out.sizeBytes = sizeBytes;
      return out;
    }
    case 'RATE_LIMITED': {
      const out: KnownDetails['RATE_LIMITED'] = {};
      const max = readDetailNumber(raw, 'maxLeaderUpdatesPerSecond');
      if (max !== undefined) out.maxLeaderUpdatesPerSecond = max;
      const retryAfterMs = readDetailNumber(raw, 'retryAfterMs');
      if (retryAfterMs !== undefined) out.retryAfterMs = retryAfterMs;
      return out;
    }
    case 'GROUP_FULL': {
      const out: KnownDetails['GROUP_FULL'] = {};
      const maxGroupSize = readDetailNumber(raw, 'maxGroupSize');
      if (maxGroupSize !== undefined) out.maxGroupSize = maxGroupSize;
      return out;
    }
    default:
      return undefined;
  }
}

/** Turns a validated server `error` message into a `SyncClientError`. */
export function fromServerError(
  message: ErrorMessage,
  options: { request?: RequestKind; fatal?: boolean } = {},
): SyncClientError {
  const raw = message.details as Details;
  const init: SyncClientErrorInit<ClientErrorCode> = {
    source: 'server',
    fatal: options.fatal ?? false,
    details: serverDetails(message.code, raw) as ErrorDetailsMap[ClientErrorCode],
  };
  if (options.request !== undefined) init.request = options.request;
  if (typeof message.message === 'string') {
    init.serverMessage = message.message.slice(0, MAX_SERVER_MESSAGE_LENGTH);
  }
  return new SyncClientError(message.code, init);
}

/** INVALID_SERVER_MESSAGE with at most 10 short issue strings (L2). */
export function invalidServerMessage(
  issues: readonly string[],
  request?: RequestKind,
): SyncClientError<'INVALID_SERVER_MESSAGE'> {
  const init: SyncClientErrorInit<'INVALID_SERVER_MESSAGE'> = {
    details: {
      issues: issues.slice(0, MAX_ISSUES).map((issue) => issue.slice(0, MAX_ISSUE_LENGTH)),
    },
  };
  if (request !== undefined) init.request = request;
  return new SyncClientError('INVALID_SERVER_MESSAGE', init);
}
