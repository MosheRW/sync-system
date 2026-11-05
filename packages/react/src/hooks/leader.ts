'use client';
import type { JoinCodes, JoinRequest, LeaderState, RosterEntry } from '@sync-system/client';
import { useCallback, useEffect, useMemo } from 'react';
import { useStoreAction } from '../action.js';
import { useSyncStore } from '../context.js';
import { useStoreSelector } from '../selector.js';
import { IDLE_QR } from '../server-state.js';
import { type SyncStore, currentGroupId, leadingGroupId } from '../store.js';
import type {
  ActionState,
  JoinPausedState,
  QrTicketState,
  SyncClientLike,
  SyncState,
} from '../types.js';

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

const pickRequests = (state: SyncState): readonly JoinRequest[] => state.joinRequests;
const pickRoster = (state: SyncState): readonly RosterEntry[] => state.roster;
const pickLeaderState = (state: SyncState): LeaderState | null => state.leaderState;
const selectViceId = (leaderState: LeaderState | null): string | null =>
  leaderState?.viceId ?? null;
const pickIsVice = (state: SyncState): boolean => state.isVice;
const pickLocked = (state: SyncState): boolean => {
  const group = state.snapshot.group;
  return group?.status === 'active' && group.locked;
};
const pickBlockList = (state: SyncState): readonly string[] => state.blockList;

/**
 * A leader action: the core call, then a re-read of the core getters (some
 * replies change leader data without an event). The value is leader-only
 * data: dropped when the role or group changes (R3).
 */
function useLeaderAction<A extends unknown[], T>(
  store: SyncStore,
  lead: string | null,
  fn: (client: SyncClientLike, ...args: A) => Promise<T>,
): ActionState<A, T> {
  return useStoreAction(
    store,
    async (client, ...args: A) => {
      try {
        return await fn(client, ...args);
      } finally {
        store.changed();
      }
    },
    lead,
  );
}

export interface JoinRequests {
  /** Pending requests while leading (names are untrusted: render as text). */
  readonly requests: readonly JoinRequest[];
  readonly approve: ActionState<[requestId: string], 'admitted' | 'group_full'>;
  readonly deny: ActionState<[requestId: string], void>;
}

/**
 * Pending join requests with approve and deny (AC19), updated on
 * `joinRequested`, `joinWithdrawn`, `joinPaused` and `joinResumed`.
 */
export function useJoinRequests(): JoinRequests {
  const store = useSyncStore('useJoinRequests');
  const lead = useStoreSelector(store, pickLead, same);
  const requests = useStoreSelector(store, pickRequests, same);
  const approve = useLeaderAction(store, lead, (client, requestId: string) =>
    client.approveJoin(requestId),
  );
  const deny = useLeaderAction(store, lead, (client, requestId: string) =>
    client.denyJoin(requestId),
  );
  return useMemo(() => Object.freeze({ requests, approve, deny }), [requests, approve, deny]);
}

/**
 * The roster of the group this client leads (AC20), in admission order; `[]`
 * otherwise. Keeps its identity until `rosterChanged` changes it. Names are
 * untrusted plain text: render as text, never as HTML.
 */
export function useRoster(): readonly RosterEntry[] {
  return useStoreSelector(useSyncStore('useRoster'), pickRoster, same);
}

export interface ViceLeader {
  /** Leader view: the vice-leader's participant ID, or null. */
  readonly viceId: string | null;
  /**
   * Member view: this client is the vice-leader. Tracked from the provider's
   * mount on (`viceChanged` events only, Q-C); reset on group change or end.
   */
  readonly isVice: boolean;
  readonly setVice: ActionState<[participantId: string], string>;
  readonly clearVice: ActionState<[], void>;
}

/** The vice-leader (AC20): leader view, member view, set and clear. */
export function useViceLeader(): ViceLeader {
  const store = useSyncStore('useViceLeader');
  const lead = useStoreSelector(store, pickLead, same);
  const viceId = useStoreSelector(store, pickLeaderState, selectViceId);
  const isVice = useStoreSelector(store, pickIsVice, same);
  const setVice = useLeaderAction(store, lead, (client, participantId: string) =>
    client.setViceLeader(participantId),
  );
  const clearVice = useLeaderAction(store, lead, (client) => client.clearViceLeader());
  return useMemo(
    () => Object.freeze({ viceId, isVice, setVice, clearVice }),
    [viceId, isVice, setVice, clearVice],
  );
}

export interface GroupLock {
  /** The active group is locked: nobody new joins by any method. */
  readonly locked: boolean;
  readonly lock: ActionState<[], void>;
  readonly unlock: ActionState<[], void>;
}

/** Lock and unlock the group (AC20). */
export function useGroupLock(): GroupLock {
  const store = useSyncStore('useGroupLock');
  const lead = useStoreSelector(store, pickLead, same);
  const locked = useStoreSelector(store, pickLocked, same);
  const lock = useLeaderAction(store, lead, (client) => client.lockGroup());
  const unlock = useLeaderAction(store, lead, (client) => client.unlockGroup());
  return useMemo(() => Object.freeze({ locked, lock, unlock }), [locked, lock, unlock]);
}

export interface MemberRemoval {
  /** The block list of the group this client leads; `[]` otherwise (R3). */
  readonly blockList: readonly string[];
  /** Removes a participant for the rest of the session; resolves with the block list. */
  readonly remove: ActionState<[participantId: string], readonly string[]>;
  /** Adds IDs to the active group's block list; resolves with the block list. */
  readonly addToBlockList: ActionState<[participantIds: readonly string[]], readonly string[]>;
}

/** Remove members and edit the block list (AC20). */
export function useMemberRemoval(): MemberRemoval {
  const store = useSyncStore('useMemberRemoval');
  const lead = useStoreSelector(store, pickLead, same);
  const blockList = useStoreSelector(store, pickBlockList, same);
  const remove = useLeaderAction(store, lead, async (client, participantId: string) => {
    const groupId = leadingGroupId(client.getSnapshot());
    const list = await client.removeMember(participantId);
    if (groupId !== null) store.recordBlockList(groupId, list);
    return list;
  });
  const addToBlockList = useLeaderAction(
    store,
    lead,
    async (client, participantIds: readonly string[]) => {
      const groupId = currentGroupId(client.getSnapshot()) ?? '';
      const list = await client.addToBlockList(groupId, participantIds);
      store.recordBlockList(groupId, list);
      return list;
    },
  );
  return useMemo(
    () => Object.freeze({ blockList, remove, addToBlockList }),
    [blockList, remove, addToBlockList],
  );
}
