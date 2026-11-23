import type { PreviewState, SyncClientSnapshot } from '@mosherw/sync-system-client';
import type { JoinFlowState, QrTicketState, SyncState } from './types.js';

/*
 * Module constants shared by every server render, every hydration and every
 * provider before its client exists (AC9, R6). Pure, deep-frozen literals:
 * nothing can write to them, so no request or provider sees another's state.
 */

/** The empty list every leader-only list falls back to. */
export const EMPTY_LIST: readonly never[] = Object.freeze([]);

/** The snapshot of a client that never connected. */
export const IDLE_SNAPSHOT: SyncClientSnapshot = Object.freeze({
  connection: Object.freeze({ status: 'idle' as const }),
  group: null,
});

export const IDLE_JOIN_FLOW: JoinFlowState = Object.freeze({ status: 'idle' as const });

export const IDLE_QR: QrTicketState = Object.freeze({ status: 'idle' as const });

export const IDLE_PREVIEW: PreviewState = Object.freeze({
  active: false,
  groupPosition: undefined,
  previewPosition: undefined,
});

/** `getServerSnapshot` of every state hook: one constant object (AC9). */
export const SERVER_STATE: SyncState = Object.freeze({
  snapshot: IDLE_SNAPSHOT,
  codes: null,
  joinRequests: EMPTY_LIST,
  roster: EMPTY_LIST,
  leaderState: null,
  blockList: EMPTY_LIST,
  joinPaused: null,
  keepAlive: null,
  isVice: false,
  leadership: null,
  lastError: null,
  joinFlow: IDLE_JOIN_FLOW,
  preview: IDLE_PREVIEW,
  storedGroups: null,
  qr: IDLE_QR,
});
