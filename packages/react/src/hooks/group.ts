'use client';
import type {
  ClientErrorCode,
  GroupEndedReason,
  GroupState,
  JsonValue,
  LeaderLifecycle,
  SyncClientError,
  SyncClientSnapshot,
} from '@sync-system/client';
import { useCallback, useMemo, useState } from 'react';
import { notConnectedResult, toSyncError, useStoreAction } from '../action.js';
import { useSyncStore } from '../context.js';
import { useStoreSelector } from '../selector.js';
import type { ActionResult, ActionState, SyncState } from '../types.js';

const pickGroup = (state: SyncState): GroupState | null => state.snapshot.group;
const pickSnapshot = (state: SyncState): SyncClientSnapshot => state.snapshot;
const same = <T>(value: T): T => value;

/** The client's group (AC23), or `null`: the core snapshot's `group`. */
export function useGroup(): GroupState | null {
  return useStoreSelector(useSyncStore('useGroup'), pickGroup, same);
}

export interface GroupEnded {
  readonly reason: GroupEndedReason;
  readonly code?: ClientErrorCode;
}

const selectEnded = (group: GroupState | null): GroupEnded | null =>
  group?.status === 'ended'
    ? Object.freeze(
        group.code === undefined
          ? { reason: group.reason }
          : { reason: group.reason, code: group.code },
      )
    : null;
const sameEnded = (a: GroupEnded | null, b: GroupEnded | null): boolean =>
  a === b || (a !== null && b !== null && a.reason === b.reason && a.code === b.code);

/**
 * Why the group ended (AC23), or `null` while it has not. `leader_timeout`
 * and `inactivity` cover a group that emptied and ended after its grace
 * period (#13 D15); `removed` is a removal by the leader.
 */
export function useGroupEnded(): GroupEnded | null {
  return useStoreSelector(useSyncStore('useGroupEnded'), pickGroup, selectEnded, sameEnded);
}

export interface Position {
  readonly hasPosition: boolean;
  readonly position: JsonValue | undefined;
  /** Connected and leading an active group. */
  readonly canUpdate: boolean;
  /**
   * The core `updatePosition` (leader only), which throws synchronously on
   * a local error: wrapped, so it returns `{ ok: false, error }` instead.
   */
  readonly updatePosition: (position: JsonValue) => ActionResult<void>;
  /** The last local error of `updatePosition`; cleared by a success. */
  readonly error: SyncClientError | null;
}

interface PositionView {
  readonly hasPosition: boolean;
  readonly position: JsonValue | undefined;
  readonly canUpdate: boolean;
}

const NO_POSITION: PositionView = Object.freeze({
  hasPosition: false,
  position: undefined,
  canUpdate: false,
});

const selectPosition = (snapshot: SyncClientSnapshot): PositionView => {
  const group = snapshot.group;
  if (group === null || (group.status !== 'active' && group.status !== 'rejoining')) {
    return NO_POSITION;
  }
  return Object.freeze({
    hasPosition: group.hasPosition,
    position: group.hasPosition ? group.position : undefined,
    canUpdate:
      snapshot.connection.status === 'connected' &&
      group.status === 'active' &&
      group.role === 'leader',
  });
};
const samePosition = (a: PositionView, b: PositionView): boolean =>
  a.hasPosition === b.hasPosition &&
  Object.is(a.position, b.position) &&
  a.canUpdate === b.canUpdate;

/** The group position and, for the leader, `updatePosition` (AC23). */
export function usePosition(): Position {
  const store = useSyncStore('usePosition');
  const view = useStoreSelector(store, pickSnapshot, selectPosition, samePosition);
  const [error, setError] = useState<SyncClientError | null>(null);
  const updatePosition = useCallback(
    (position: JsonValue): ActionResult<void> => {
      const client = store.client;
      if (client === null) {
        const result = notConnectedResult();
        setError(result.error);
        return result;
      }
      try {
        client.updatePosition(position);
        setError(null);
        return Object.freeze({ ok: true as const, value: undefined });
      } catch (caught) {
        const failure = toSyncError(caught);
        setError(failure);
        return Object.freeze({ ok: false as const, error: failure });
      }
    },
    [store],
  );
  return useMemo(
    () => Object.freeze({ ...view, updatePosition, error }),
    [view, updatePosition, error],
  );
}

export interface LeaderStatus {
  /** False while the leader is offline (members); always true for a leader. */
  readonly online: boolean;
  readonly lifecycle: LeaderLifecycle;
}

const selectLeaderStatus = (group: GroupState | null): LeaderStatus | null =>
  group?.status === 'active'
    ? Object.freeze({ online: group.leaderOnline, lifecycle: group.leader })
    : null;
const sameLeaderStatus = (a: LeaderStatus | null, b: LeaderStatus | null): boolean =>
  a === b || (a !== null && b !== null && a.online === b.online && a.lifecycle === b.lifecycle);

/** The leader's status as this client sees it (active group only), else `null`. */
export function useLeaderStatus(): LeaderStatus | null {
  return useStoreSelector(
    useSyncStore('useLeaderStatus'),
    pickGroup,
    selectLeaderStatus,
    sameLeaderStatus,
  );
}

const selectRemoved = (snapshot: SyncClientSnapshot): boolean =>
  (snapshot.connection.status === 'closed' && snapshot.connection.reason === 'removed') ||
  (snapshot.group?.status === 'ended' && snapshot.group.reason === 'removed');

/**
 * True once the leader removed this participant (AC22): the connection is
 * closed with reason `removed` (close 4004) or the group ended `removed`.
 * Terminal: nothing in the package reconnects or rejoins after it.
 */
export function useRemoved(): boolean {
  return useStoreSelector(useSyncStore('useRemoved'), pickSnapshot, selectRemoved);
}

export interface GroupExit {
  /** Leader: ends the group. */
  readonly end: ActionState<[], void>;
  /** Member: leaves the group. */
  readonly leave: ActionState<[], void>;
}

/** End (leader) or leave (member) the group. */
export function useGroupExit(): GroupExit {
  const store = useSyncStore('useGroupExit');
  const end = useStoreAction(store, (client) => client.endGroup());
  const leave = useStoreAction(store, (client) => client.leaveGroup());
  return useMemo(() => Object.freeze({ end, leave }), [end, leave]);
}
