'use client';
import type { JoinCodes } from '@sync-system/client';
import { useCallback, useEffect, useMemo } from 'react';
import { useStoreAction } from '../action.js';
import { useSyncStore } from '../context.js';
import { useStoreSelector } from '../selector.js';
import { IDLE_QR } from '../server-state.js';
import { leadingGroupId } from '../store.js';
import type { ActionState, JoinPausedState, QrTicketState, SyncState } from '../types.js';

const same = <T>(value: T): T => value;
const pickLead = (state: SyncState): string | null => leadingGroupId(state.snapshot);
const pickCodes = (state: SyncState): JoinCodes | null => state.codes;
const pickJoinPaused = (state: SyncState): JoinPausedState | null => state.joinPaused;
const selectRetryAt = (paused: JoinPausedState | null): { readonly retryAt: number } | null =>
  paused === null ? null : Object.freeze({ retryAt: paused.retryAt });
const pickJoiningEnabled = (state: SyncState): boolean => {
  const group = state.snapshot.group;
  return group?.status === 'active' && group.role === 'leader' && !group.locked;
};
const pickQr = (state: SyncState): QrTicketState => state.qr;

export interface LeaderCodes {
  /** The current codes while this client leads (`generation` grows on every change), else `null`. */
  readonly codes: JoinCodes | null;
  /** Door-code joining is paused after repeated failures, until `retryAt` (local epoch ms). */
  readonly joinPaused: { readonly retryAt: number } | null;
  /** Leading an unlocked group. */
  readonly joiningEnabled: boolean;
  /** Replaces every code; older QR tickets stop working (core `rotateCodes`). */
  readonly rotate: ActionState<[], JoinCodes>;
  /**
   * Unlocks (`true`) or locks (`false`) all joining, by every method (Q-A).
   * Codes and tickets stay valid and work again after an unlock: a leaked
   * code needs `rotate`.
   */
  readonly setJoiningEnabled: ActionState<[enabled: boolean], void>;
}

/** The leader's join codes, rotation and lock of all joining (AC18, Q-A). */
export function useLeaderCodes(): LeaderCodes {
  const store = useSyncStore('useLeaderCodes');
  const lead = useStoreSelector(store, pickLead, same);
  const codes = useStoreSelector(store, pickCodes, same);
  const joinPaused = useStoreSelector(store, pickJoinPaused, selectRetryAt);
  const joiningEnabled = useStoreSelector(store, pickJoiningEnabled, same);
  // Values are leader-only data: dropped when the role or group changes (R3).
  const rotate = useStoreAction(store, (client) => client.rotateCodes(), lead);
  const setJoiningEnabled = useStoreAction(
    store,
    (client, enabled: boolean) => (enabled ? client.unlockGroup() : client.lockGroup()),
    lead,
  );
  return useMemo(
    () => Object.freeze({ codes, joinPaused, joiningEnabled, rotate, setJoiningEnabled }),
    [codes, joinPaused, joiningEnabled, rotate, setJoiningEnabled],
  );
}

export interface QrTicketOptions {
  /**
   * Run the re-issue timer (default true). Pass `false` while the QR is not
   * on screen, so no ticket is minted that nobody sees (R8).
   */
  readonly enabled?: boolean;
}

export interface QrTicketHook {
  readonly state: QrTicketState;
  /**
   * Asks for a new ticket now. Ignored while a request is in flight, during
   * a rate-limit wait and within 10 s of the last issue, unless the ticket
   * expired (R2).
   */
  readonly refresh: () => void;
}

/**
 * The leader's QR ticket with automatic re-issue (AC18): on mount, at about
 * 80 % of the lifetime, and at once after the codes were rotated, resumed,
 * changed by a removal or superseded (R1). One ticket and one timer per
 * provider, shared by every consumer; cleared when the last one unmounts.
 */
export function useQrTicket(options: QrTicketOptions = {}): QrTicketHook {
  const { enabled = true } = options;
  const store = useSyncStore('useQrTicket');
  const state = useStoreSelector(store, pickQr, same);
  useEffect(() => {
    if (!enabled) return undefined;
    store.qr.acquire();
    return () => store.qr.release();
  }, [store, enabled]);
  const refresh = useCallback(() => {
    if (enabled) store.qr.refresh();
  }, [store, enabled]);
  return useMemo(
    () => Object.freeze({ state: enabled ? state : IDLE_QR, refresh }),
    [enabled, state, refresh],
  );
}
