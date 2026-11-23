'use client';
import type { GroupState, Role } from '@mosherw/sync-system-client';
import { useCallback, useMemo } from 'react';
import { useStoreAction } from '../action.js';
import { useSyncStore } from '../context.js';
import { useStoreSelector } from '../selector.js';
import type { ActionState, LeadershipChange, SyncState } from '../types.js';

const same = <T>(value: T): T => value;
const pickGroup = (state: SyncState): GroupState | null => state.snapshot.group;
const selectRole = (group: GroupState | null): Role | null =>
  group !== null &&
  (group.status === 'active' || group.status === 'rejoining' || group.status === 'waiting')
    ? group.role
    : null;
const selectTakeBack = (group: GroupState | null): boolean =>
  group?.status === 'active' && group.takeBackAvailable;
const pickLeadership = (state: SyncState): LeadershipChange | null => state.leadership;

export interface Leadership {
  /** This client's role in its group, or null. */
  readonly role: Role | null;
  /** Leads an active group. */
  readonly isLeader: boolean;
  /** This member is the displaced leader and may take the lead back (AC21). */
  readonly takeBackAvailable: boolean;
  /**
   * The last leadership change seen since the provider mounted: "you're now
   * leading", leadership lost, or another participant leads. Reset on group
   * change or end.
   */
  readonly lastChange: LeadershipChange | null;
  /** Clears `lastChange` (the app showed it). */
  readonly dismiss: () => void;
  /** Takes the lead back (core `takeBackLeadership`). */
  readonly takeBack: ActionState<[], void>;
}

/** Leadership: now leading, lost or changed, and take-back (AC21). */
export function useLeadership(): Leadership {
  const store = useSyncStore('useLeadership');
  const role = useStoreSelector(store, pickGroup, selectRole);
  const isLeader = useStoreSelector(
    store,
    pickGroup,
    (group: GroupState | null) => group?.status === 'active' && group.role === 'leader',
  );
  const takeBackAvailable = useStoreSelector(store, pickGroup, selectTakeBack);
  const lastChange = useStoreSelector(store, pickLeadership, same);
  const dismiss = useCallback(() => store.dismissLeadership(), [store]);
  const takeBack = useStoreAction(store, (client) => client.takeBackLeadership());
  return useMemo(
    () => Object.freeze({ role, isLeader, takeBackAvailable, lastChange, dismiss, takeBack }),
    [role, isLeader, takeBackAvailable, lastChange, dismiss, takeBack],
  );
}
