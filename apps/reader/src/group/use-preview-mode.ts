import { useConnection, usePreview, useSyncClient } from '@sync-system/react';
import { useCallback, useMemo } from 'react';
import { type LeaderError, leaderActionError } from './leader-errors.js';
import { decodePosition, encodePosition } from './position.js';

export interface PreviewMode {
  /** Previewing now (the store's state, for rendering). */
  readonly active: boolean;
  /** The page the leader views while previewing, or `null`. */
  readonly viewIndex: number | null;
  /**
   * The core's live state, read synchronously (#25 R21, L3): page turns are
   * routed by this, never by a render-time mirror.
   */
  readonly isActiveNow: () => boolean;
  /** Starts previewing at `index`; nothing is sent (the core sends a throttled activity). */
  readonly start: (index: number) => void;
  /** A page turn while previewing: a preview move, never a position update (AC41). */
  readonly move: (index: number) => void;
  /**
   * Moves the group to the previewed page with one position update, then
   * ends the preview (F15.4). Synchronous: no pending state (Gate 2). On a
   * failure the preview stays on at the same page and the error comes back.
   */
  readonly bring: (isLeader: boolean) => LeaderError | null;
  /** Ends the preview; returns the group's page to go back to (nothing is sent). */
  readonly returnToGroup: () => number | null;
  readonly end: () => void;
}

/** The leader's preview on the reading page (#25 architecture 7.3, AC40, AC41). */
export function usePreviewMode(pageCount: number): PreviewMode {
  const preview = usePreview();
  const client = useSyncClient();
  const connection = useConnection();
  const status = connection.status;
  const isActiveNow = useCallback(() => client?.preview.getState().active ?? false, [client]);
  const viewIndex = preview.active ? decodePosition(preview.previewPosition, pageCount) : null;
  const { start: startPreview, move: movePreview, bringGroupHere, returnToGroup, end } = preview;

  const start = useCallback((index: number) => startPreview(encodePosition(index)), [startPreview]);
  const move = useCallback((index: number) => movePreview(encodePosition(index)), [movePreview]);
  const bring = useCallback(
    (isLeader: boolean): LeaderError | null => {
      // The core ends the preview before it sends: check what fails first.
      if (!isLeader) return { key: 'errNotLeader', close: true };
      if (status !== 'connected') return { key: 'errNetwork' };
      const target = client?.preview.getState().previewPosition;
      const result = bringGroupHere();
      if (result.ok) return null;
      if (target !== undefined) startPreview(target);
      return leaderActionError('bring', result.error) ?? { key: 'errServer' };
    },
    [status, client, bringGroupHere, startPreview],
  );
  const back = useCallback(() => {
    const position = returnToGroup();
    return position === undefined ? null : decodePosition(position, pageCount);
  }, [returnToGroup, pageCount]);

  return useMemo(
    () => ({
      active: preview.active,
      viewIndex,
      isActiveNow,
      start,
      move,
      bring,
      returnToGroup: back,
      end,
    }),
    [preview.active, viewIndex, isActiveNow, start, move, bring, back, end],
  );
}
