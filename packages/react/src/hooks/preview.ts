'use client';
import type { JsonValue, PreviewState } from '@sync-system/client';
import { useMemo } from 'react';
import { notConnectedResult, toSyncError } from '../action.js';
import { useSyncStore } from '../context.js';
import { useStoreSelector } from '../selector.js';
import type { ActionResult, SyncState } from '../types.js';

const pickPreview = (state: SyncState): PreviewState => state.preview;
const same = <T>(value: T): T => value;

export interface Preview extends PreviewState {
  /** Starts previewing at the group's position (or `position`); nothing is sent. */
  readonly start: (position?: JsonValue) => void;
  /** Moves inside the preview; only a throttled "leader active" signal is sent. */
  readonly move: (position: JsonValue) => void;
  /** Ends the preview without moving the group. */
  readonly end: () => void;
  /**
   * Moves the group to the previewed position (one normal update), then
   * ends the preview. The core's synchronous errors become `{ ok: false }`.
   */
  readonly bringGroupHere: () => ActionResult<void>;
  /** Ends the preview; returns the group's position (the group never moved). */
  readonly returnToGroup: () => JsonValue | undefined;
}

/**
 * The leader's private preview (AC24) over the core `client.preview`: browse
 * ahead without moving the group. The core ends it on demotion or a new
 * group; the state follows.
 */
export function usePreview(): Preview {
  const store = useSyncStore('usePreview');
  const state = useStoreSelector(store, pickPreview, same);
  const actions = useMemo(() => {
    const preview = () => store.client?.preview;
    return {
      start: (position?: JsonValue) => {
        preview()?.start(position);
        store.previewChanged();
      },
      move: (position: JsonValue) => {
        preview()?.move(position);
        store.previewChanged();
      },
      end: () => {
        preview()?.end();
        store.previewChanged();
      },
      bringGroupHere: (): ActionResult<void> => {
        const target = preview();
        if (target === undefined) return notConnectedResult();
        try {
          target.bringGroupHere();
          return Object.freeze({ ok: true as const, value: undefined });
        } catch (error) {
          return Object.freeze({ ok: false as const, error: toSyncError(error) });
        } finally {
          store.previewChanged();
        }
      },
      returnToGroup: () => {
        const position = preview()?.returnToGroup();
        store.previewChanged();
        return position;
      },
    };
  }, [store]);
  return useMemo(() => Object.freeze({ ...state, ...actions }), [state, actions]);
}
