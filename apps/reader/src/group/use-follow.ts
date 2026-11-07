import { usePosition } from '@sync-system/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type FollowEvent, type FollowState, INITIAL_FOLLOW, follow } from './follow.js';
import { decodePosition } from './position.js';
import type { FollowMode } from './session-store.js';

export interface FollowOptions {
  /** Following applies: a member whose content check passed (phase `member`). */
  readonly active: boolean;
  /** The membership (group ID); a new one starts the reducer again. */
  readonly membership: string | null;
  readonly pageCount: number;
  /** The reader's current page. */
  readonly ownIndex: () => number;
  /** No page turn since load and no restored page (U1). */
  readonly fresh: () => boolean;
  readonly lateJoinMs: number;
  /** The mode stored for this tab when the membership came back by resume, else `null`. */
  readonly resumedMode: () => FollowMode | null;
  /** Performs a jump with the reading screen's own move. */
  readonly onJump: (index: number) => void;
  /** The mode changed (stored in the pointer, Decision Q3). */
  readonly onMode: (mode: FollowMode) => void;
}

export interface Follow {
  readonly state: FollowState;
  /** The group's official page (AC27: never a preview), or `null`. */
  readonly groupIndex: number | null;
  readonly userTurned: (ownIndex: number) => void;
  readonly goToGroup: () => void;
  readonly stayHere: () => void;
  readonly lateExpired: () => void;
}

/**
 * Wires the pure follow reducer to the group's official position
 * (`usePosition`, decoded strictly; a malformed or out-of-range value is
 * ignored: no move, no prompt, AC29) and to the reading screen (#24
 * architecture 7.2). Positions are ignored while not `active` (blocked,
 * before the content check, AC21, AC22).
 */
export function useFollow(options: FollowOptions): Follow {
  const position = usePosition();
  const groupIndex = position.hasPosition
    ? decodePosition(position.position, options.pageCount)
    : null;
  const [state, setState] = useState<FollowState>(INITIAL_FOLLOW);
  const stateRef = useRef(state);
  const opts = useRef(options);
  opts.current = options;

  const dispatch = useCallback((event: FollowEvent) => {
    const before = stateRef.current;
    const next = follow(before, event);
    stateRef.current = next.state;
    setState(next.state);
    if (next.state.mode !== before.mode) opts.current.onMode(next.state.mode);
    if (next.jumpTo !== null) opts.current.onJump(next.jumpTo);
  }, []);

  // A new membership that passed the check: position it once (F8, Q3).
  const started = useRef<string | null>(null);
  const { active, membership } = options;
  useEffect(() => {
    if (!active || membership === null) {
      if (membership === null) started.current = null;
      return;
    }
    if (started.current === membership) return;
    started.current = membership;
    stateRef.current = INITIAL_FOLLOW;
    const o = opts.current;
    const storedMode = o.resumedMode();
    dispatch(
      storedMode !== null
        ? { type: 'resumed', groupIndex, ownIndex: o.ownIndex(), storedMode }
        : {
            type: 'admitted',
            groupIndex,
            ownIndex: o.ownIndex(),
            fresh: o.fresh(),
            lateJoinMs: o.lateJoinMs,
            now: performance.now(),
          },
    );
    // groupIndex is read once here; later changes are groupMoved below.
  }, [active, membership, dispatch]);

  // The leader moved: follow, or prompt (AC25, AC26).
  const seenIndex = useRef<number | null>(null);
  useEffect(() => {
    if (!active || started.current === null) {
      seenIndex.current = groupIndex;
      return;
    }
    if (groupIndex === null || groupIndex === seenIndex.current) return;
    seenIndex.current = groupIndex;
    if (stateRef.current.groupIndex === groupIndex) return;
    dispatch({ type: 'groupMoved', index: groupIndex, ownIndex: opts.current.ownIndex() });
  }, [active, groupIndex, dispatch]);

  return {
    state: active ? state : INITIAL_FOLLOW,
    groupIndex,
    userTurned: useCallback(
      (ownIndex: number) => {
        if (started.current !== null) dispatch({ type: 'userTurned', ownIndex });
      },
      [dispatch],
    ),
    goToGroup: useCallback(() => dispatch({ type: 'goToGroup' }), [dispatch]),
    stayHere: useCallback(() => dispatch({ type: 'stayHere' }), [dispatch]),
    lateExpired: useCallback(() => dispatch({ type: 'lateExpired' }), [dispatch]),
  };
}
