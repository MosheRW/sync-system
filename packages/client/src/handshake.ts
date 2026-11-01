import {
  CloseCode,
  ErrorCode,
  type ErrorMessage,
  type HelloMessage,
  type HelloOkMessage,
  type WelcomeMessage,
} from '@sync-system/protocol';
import type { BusySignal } from './backoff.js';
import {
  type ErrorDetailsMap,
  FATAL_HANDSHAKE_CODES,
  SyncClientError,
  fromServerError,
} from './errors.js';
import { findOutOfBoundsLimit } from './limits.js';
import { CLIENT_PROTOCOL_VERSION, MIN_SERVER_PROTOCOL_VERSION } from './version.js';

/** A failure and, for "server busy" signals, which one (M3). */
export interface Classified {
  error: SyncClientError;
  busy?: BusySignal;
}

/**
 * Fatal SERVER_UNSUPPORTED with both sides' versions (AC12), and the limit
 * name if a `hello.ok` limit was out of bounds (R2-L2).
 */
export function serverUnsupported(
  welcome: WelcomeMessage,
  limit?: ErrorDetailsMap['SERVER_UNSUPPORTED']['limit'],
): SyncClientError<'SERVER_UNSUPPORTED'> {
  const details: ErrorDetailsMap['SERVER_UNSUPPORTED'] = {
    clientProtocolVersion: CLIENT_PROTOCOL_VERSION,
    minServerProtocolVersion: MIN_SERVER_PROTOCOL_VERSION,
    serverProtocolVersion: welcome.protocolVersion,
    serverMinProtocolVersion: welcome.minProtocolVersion,
  };
  if (limit !== undefined) details.limit = limit;
  return new SyncClientError('SERVER_UNSUPPORTED', { details, fatal: true, request: 'hello' });
}

/**
 * Client-side version check (AC12): the server must accept this client's
 * protocol, and speak at least the oldest protocol this client supports.
 */
export function checkWelcome(
  welcome: WelcomeMessage,
): SyncClientError<'SERVER_UNSUPPORTED'> | undefined {
  if (
    welcome.minProtocolVersion > CLIENT_PROTOCOL_VERSION ||
    welcome.protocolVersion < MIN_SERVER_PROTOCOL_VERSION
  ) {
    return serverUnsupported(welcome);
  }
  return undefined;
}

/**
 * `hello.ok` limits outside the client bounds are fatal (M1, R2-L2): they are
 * deterministic, so retrying would loop forever.
 */
export function checkHelloOk(
  helloOk: HelloOkMessage,
  welcome: WelcomeMessage,
): SyncClientError<'SERVER_UNSUPPORTED'> | undefined {
  const limit = findOutOfBoundsLimit(helloOk.limits);
  return limit === undefined ? undefined : serverUnsupported(welcome, limit);
}

/** The `hello` message (AC8). Item 3 adds the token here. */
export function buildHello(reqId: string, apiKey: string, appVersion: string): HelloMessage {
  return { type: 'hello', reqId, protocolVersion: CLIENT_PROTOCOL_VERSION, apiKey, appVersion };
}

/**
 * A server `error` during the handshake (Q4, Q-A, AC13, AC14). Bad key, bad
 * or old versions and the other deterministic rejections are fatal; the
 * connection limit, handshake timeout and internal errors are retryable.
 */
export function classifyHandshakeError(message: ErrorMessage): Classified {
  const fatal = FATAL_HANDSHAKE_CODES.has(message.code);
  const error = fromServerError(message, { request: 'hello', fatal });
  if (message.code === ErrorCode.APP_CONNECTION_LIMIT) {
    return { error, busy: 'app_connection_limit' };
  }
  if (message.code === ErrorCode.TOO_MANY_MESSAGES) return { error, busy: 'too_many_messages' };
  return { error };
}

/**
 * A socket close (or error, as 1006). During the handshake a bare 4001 is
 * fatal (Q-A). 1001, 4003 and 4008 are busy signals (M3). Everything else is
 * a retryable CONNECTION_LOST.
 */
export function classifyClose(code: number, duringHandshake: boolean): Classified {
  switch (code) {
    case CloseCode.HANDSHAKE_REJECTED:
      if (duringHandshake) {
        return {
          error: new SyncClientError('HANDSHAKE_REJECTED', { fatal: true, request: 'hello' }),
        };
      }
      break;
    case CloseCode.HANDSHAKE_TIMEOUT:
      if (duringHandshake) {
        return {
          error: new SyncClientError('HANDSHAKE_TIMEOUT', { source: 'server', request: 'hello' }),
        };
      }
      break;
    case CloseCode.APP_CONNECTION_LIMIT:
      return {
        error: new SyncClientError('APP_CONNECTION_LIMIT', { source: 'server' }),
        busy: 'app_connection_limit',
      };
    case CloseCode.POLICY_VIOLATION:
      return {
        error: new SyncClientError('TOO_MANY_MESSAGES', { source: 'server' }),
        busy: 'too_many_messages',
      };
    case CloseCode.GOING_AWAY:
      return { error: new SyncClientError('CONNECTION_LOST'), busy: 'going_away' };
    default:
      break;
  }
  return { error: new SyncClientError('CONNECTION_LOST') };
}
