'use client';
import type { ConnectionState, ResumedGroup, ResumeOptions } from '@mosherw/sync-system-client';
import { useEffect, useMemo } from 'react';
import { useStoreAction } from '../action.js';
import { useSyncStore } from '../context.js';
import { useStoreSelector } from '../selector.js';
import type { ActionState, StoredGroup, SyncState } from '../types.js';

const pickGroups = (state: SyncState): readonly StoredGroup[] | null => state.storedGroups;
const pickStatus = (state: SyncState): ConnectionState['status'] =>
  state.snapshot.connection.status;
const same = <T>(value: T): T => value;

export interface StoredGroupsOptions {
  /**
   * Check the stored groups once per connected session (Q-D). Default
   * `false`: the package makes no network call the app did not ask for.
   */
  readonly checkOnConnect?: boolean;
}

export interface StoredGroups {
  /** The last check's result, or `null` before any check. */
  readonly groups: readonly StoredGroup[] | null;
  /** Checks every stored group (core `checkTokens`); one at a time. */
  readonly check: ActionState<[], readonly StoredGroup[]>;
  /** Resumes one stored group (core `resumeGroup`). Never called on its own. */
  readonly resume: ActionState<[groupId: string, options?: ResumeOptions], ResumedGroup>;
}

/**
 * Stored groups with their availability (live, resumable, gone) and a
 * resume action (AC16). Nothing happens on the server. A group reported
 * `gone` is never recreated or rejoined by the package (AC23).
 */
export function useStoredGroups(options: StoredGroupsOptions = {}): StoredGroups {
  const { checkOnConnect = false } = options;
  const store = useSyncStore('useStoredGroups');
  const groups = useStoreSelector(store, pickGroups, same);
  const status = useStoreSelector(store, pickStatus, same);
  const check = useStoreAction(store, () => store.checkStoredGroups());
  const resume = useStoreAction(store, (client, groupId: string, resumeOptions?: ResumeOptions) =>
    client.resumeGroup(groupId, resumeOptions),
  );

  useEffect(() => {
    // Opt-in only (Q-D); the store runs it once per connected session.
    if (checkOnConnect && status === 'connected') store.checkOnConnect();
  }, [store, checkOnConnect, status]);

  return useMemo(() => Object.freeze({ groups, check, resume }), [groups, check, resume]);
}
