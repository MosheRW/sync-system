import type { SyncClientError } from '@mosherw/sync-system-react';
import type { I18n } from '../i18n/index.js';
import type { Messages } from '../i18n/en.js';
import { formatLong } from './countdown.js';

/** Where focus goes when the message shows (design 7.4). */
export type ErrorFocus = 'code' | 'door' | 'name' | 'message' | 'heading';

export interface ErrorView {
  readonly key: keyof Messages;
  readonly focus: ErrorFocus;
  /** A wait the server gave (`retryAfterMs`), for "Try again in {time}". */
  readonly retryAfterMs?: number;
}

const NETWORK = new Set([
  'NOT_CONNECTED',
  'CONNECTION_LOST',
  'REQUEST_TIMEOUT',
  'NO_WEBSOCKET',
  'RECONNECT_FAILED',
  'HANDSHAKE_TIMEOUT',
  'CLOSED',
]);

function retryAfter(error: SyncClientError): number | undefined {
  const details = error.details as { retryAfterMs?: unknown } | undefined;
  const ms = details?.retryAfterMs;
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * Join and create errors to messages (design 7.4, #24 AC19): one table,
 * `errServer` for anything unknown. `null` for `JOIN_CANCELLED` (the user
 * cancelled; no message). Messages are static strings plus a formatted
 * duration: no code, ticket, server text or name is ever put into them.
 */
export function errorView(error: SyncClientError): ErrorView | null {
  const code: string = error.code;
  if (code === 'JOIN_CANCELLED') return null;
  if (NETWORK.has(code)) return { key: 'errNetwork', focus: 'message' };
  switch (code) {
    case 'CODE_NOT_FOUND':
    case 'INVALID_JOIN_CODE':
      return { key: 'errCodeNotFound', focus: 'code' };
    case 'DOOR_CODE_WRONG':
      return { key: 'errDoorWrong', focus: 'door' };
    case 'JOIN_PAUSED': {
      const ms = retryAfter(error);
      return ms !== undefined
        ? { key: 'errJoinPaused', focus: 'message', retryAfterMs: ms }
        : { key: 'errJoinPausedNoTime', focus: 'message' };
    }
    case 'RATE_LIMITED': {
      const ms = retryAfter(error);
      return ms !== undefined
        ? { key: 'errRateLimited', focus: 'message', retryAfterMs: ms }
        : { key: 'errRateLimitedNoTime', focus: 'message' };
    }
    case 'JOIN_DENIED':
      return { key: 'errJoinDenied', focus: 'message' };
    case 'APPROVAL_TIMEOUT':
      return { key: 'errApprovalTimeout', focus: 'message' };
    case 'APPROVAL_QUEUE_FULL':
      return { key: 'errQueueFull', focus: 'message' };
    case 'QR_INVALID':
      return { key: 'errQrInvalid', focus: 'heading' };
    case 'QR_EXPIRED':
      return { key: 'errQrExpired', focus: 'heading' };
    case 'GROUP_LOCKED':
      return { key: 'errGroupLocked', focus: 'message' };
    case 'GROUP_FULL':
      return { key: 'errGroupFull', focus: 'message' };
    case 'JOIN_METHOD_NOT_ALLOWED':
    case 'JOIN_METHOD_UNAVAILABLE':
      return { key: 'errMethod', focus: 'message' };
    case 'ALREADY_IN_GROUP':
      return { key: 'errAlreadyInGroup', focus: 'message' };
    case 'INVALID_DISPLAY_NAME':
      return { key: 'nameInvalidChars', focus: 'name' };
    case 'APP_CONNECTION_LIMIT':
    case 'CODES_EXHAUSTED':
    case 'APP_GROUP_LIMIT':
      return { key: 'errBusy', focus: 'message' };
    case 'INVALID_API_KEY':
    case 'HANDSHAKE_REJECTED':
      return { key: 'errSetup', focus: 'message' };
    default:
      return { key: 'errServer', focus: 'message' };
  }
}

/** The message text, with the wait filled in (an LTR time in words). */
export function errorText(view: ErrorView, i18n: I18n, remainingMs?: number): string {
  const template = i18n.t[view.key];
  const ms = remainingMs ?? view.retryAfterMs;
  return ms === undefined ? template : i18n.format(template, { time: formatLong(ms, i18n) });
}
