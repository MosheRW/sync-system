'use client';
import type {
  CreatedGroup,
  CreateGroupOptions,
  JoinByQrOptions,
  JoinedGroup,
  JoinOptions,
  JsonObject,
  JsonValue,
} from '@sync-system/client';
import { useCallback, useMemo } from 'react';
import { useStoreAction } from '../action.js';
import { useSyncStore } from '../context.js';
import { useStoreSelector } from '../selector.js';
import { leadingGroupId } from '../store.js';
import type { ActionState, JoinFlowState, SyncState } from '../types.js';

const pickLead = (state: SyncState): string | null => leadingGroupId(state.snapshot);
const pickFlow = (state: SyncState): JoinFlowState => state.joinFlow;
const same = <T>(value: T): T => value;

/**
 * Creates a group with this client as leader (AC15). The value holds the
 * group's codes: it is dropped when this client stops leading that group (R3).
 */
export function useCreateGroup(): ActionState<
  [metadata: JsonObject, initialPosition?: JsonValue, options?: CreateGroupOptions],
  CreatedGroup
> {
  const store = useSyncStore('useCreateGroup');
  const lead = useStoreSelector(store, pickLead, same);
  return useStoreAction(
    store,
    (client, metadata: JsonObject, initialPosition?: JsonValue, options?: CreateGroupOptions) =>
      client.createGroup(metadata, initialPosition, options),
    lead,
  );
}

/**
 * Joins by group code or alpha code (AC15), with `options.doorCode` (method
 * A) or `options.displayName` (method B, approval). Followed by
 * `useJoinApproval().flow`. There is no join by group ID (removed in #10).
 */
export function useJoinByCode(): ActionState<[code: string, options?: JoinOptions], JoinedGroup> {
  const store = useSyncStore('useJoinByCode');
  return useStoreAction(store, (client, code: string, options?: JoinOptions) => {
    const joined = client.joinByCode(code, options);
    store.recordJoin(joined);
    return joined;
  });
}

/** Joins with a QR ticket (AC15). Followed by `useJoinApproval().flow`. */
export function useJoinByQr(): ActionState<
  [ticket: string, options?: JoinByQrOptions],
  JoinedGroup
> {
  const store = useSyncStore('useJoinByQr');
  return useStoreAction(store, (client, ticket: string, options?: JoinByQrOptions) => {
    const joined = client.joinByQr(ticket, options);
    store.recordJoin(joined);
    return joined;
  });
}

export interface JoinApproval {
  /**
   * `waiting` from the snapshot (`awaiting_approval`); the outcome of the
   * last join call of any join hook otherwise (AC17, Q-B).
   */
  readonly flow: JoinFlowState;
  /** Withdraws the pending request (core `cancelJoin`). */
  readonly cancel: ActionState<[], void>;
  /** Back to `idle` (the app showed the outcome). */
  readonly reset: () => void;
}

/** The approval flow of a join (AC17): waiting, paused, approved, denied, withdrawn. */
export function useJoinApproval(): JoinApproval {
  const store = useSyncStore('useJoinApproval');
  const flow = useStoreSelector(store, pickFlow, same);
  const cancel = useStoreAction(store, (client) => client.cancelJoin());
  const reset = useCallback(() => store.resetJoinFlow(), [store]);
  return useMemo(() => Object.freeze({ flow, cancel, reset }), [flow, cancel, reset]);
}
