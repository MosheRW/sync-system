import type { SyncClientError } from '@mosherw/sync-system-react';
import type { Messages } from '../i18n/en.js';

/**
 * Leader action errors to messages (#25 architecture 7.2, design 7.10,
 * 7.11, AC58). Pure, one table. Messages are fixed strings plus a name (as
 * a `PlainText` node, never formatted into markup) and a clamped wait; the
 * server's `message` text is never shown (R19).
 */
export type LeaderAction =
  'setVice' | 'clearVice' | 'remove' | 'lock' | 'unlock' | 'bring' | 'keepAlive' | 'takeBack';

export interface LeaderError {
  readonly key: keyof Messages;
  /** The template has `{name}`: the caller renders the person's name there. */
  readonly withName?: true;
  /** A wait the server gave, clamped (R22); the button is inactive until it ends. */
  readonly retryAfterMs?: number;
  /** The control should close (its target is gone, or the user no longer leads). */
  readonly close?: true;
  /** Remove: the person is gone; the message goes above the list (design F17.5). */
  readonly aboveList?: true;
  /** Take the lead: refused for good; a sticky banner says so (design F21.5). */
  readonly refused?: true;
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

/** The longest server wait the reader believes (R22, L2). */
export const MAX_RETRY_AFTER_MS = 10 * 60_000;

/** A finite, positive wait up to 10 minutes, else `undefined` (the no-time message). */
export function clampRetryAfter(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_RETRY_AFTER_MS
    ? value
    : undefined;
}

function actionRow(action: LeaderAction, code: string): LeaderError | undefined {
  switch (action) {
    case 'setVice':
      if (code === 'NOT_ALLOWED') return { key: 'errViceAway', withName: true };
      if (code === 'PARTICIPANT_NOT_FOUND') return { key: 'errPersonGone', withName: true };
      return undefined;
    case 'clearVice':
      if (code === 'PARTICIPANT_NOT_FOUND') return { key: 'errPersonGone', withName: true };
      return undefined;
    case 'remove':
      if (code === 'BLOCK_LIST_FULL') return { key: 'errBlockListFull' };
      if (code === 'CODES_EXHAUSTED') return { key: 'errRemoveCodes' };
      if (code === 'PARTICIPANT_NOT_FOUND') {
        return { key: 'errPersonGone', withName: true, close: true, aboveList: true };
      }
      if (code === 'NOT_ALLOWED') return { key: 'errServer' };
      return undefined;
    case 'takeBack':
      if (code === 'NOT_ALLOWED') return { key: 'takeBackNotAllowed', close: true, refused: true };
      return undefined;
    default:
      return undefined;
  }
}

/** The message for a failed leader action, or `null` for no message (NOT_IN_GROUP). */
export function leaderActionError(
  action: LeaderAction,
  error: SyncClientError,
): LeaderError | null {
  const code: string = error.code;
  const specific = actionRow(action, code);
  if (specific !== undefined) return specific;
  if (code === 'NOT_IN_GROUP') return null;
  if (code === 'NOT_LEADER') return { key: 'errNotLeader', close: true };
  if (NETWORK.has(code)) return { key: 'errNetwork' };
  if (code === 'RATE_LIMITED') {
    const details = error.details as { retryAfterMs?: unknown } | undefined;
    const ms = clampRetryAfter(details?.retryAfterMs);
    return ms !== undefined
      ? { key: 'errRateLimited', retryAfterMs: ms }
      : { key: 'errRateLimitedNoTime' };
  }
  return { key: 'errServer' };
}
