import type { FollowMode } from './session-store.js';

/**
 * A member's following state (#24 architecture 7.2, AC25-AC28). Pure: the
 * hook feeds it events and performs the `jumpTo` it returns with the
 * reading screen's own page move, so the animation and "Page n of N" work
 * as for a normal turn.
 */
export interface FollowState {
  readonly mode: FollowMode;
  /** The group's official page (decoded position v1), or `null`. */
  readonly groupIndex: number | null;
  /** The jump prompt for a browsing member: always the latest group page, never stacked. */
  readonly jump: { readonly index: number } | null;
  /** The late-joiner countdown; `deadline` on a monotonic clock. */
  readonly late: { readonly index: number; readonly deadline: number } | null;
}

export const INITIAL_FOLLOW: FollowState = Object.freeze({
  mode: 'following',
  groupIndex: null,
  jump: null,
  late: null,
});

export type FollowEvent =
  /** Admitted (after a match or Follow anyway); `fresh`: no turn and no restored page (U1). */
  | {
      readonly type: 'admitted';
      readonly groupIndex: number | null;
      readonly ownIndex: number;
      readonly fresh: boolean;
      readonly lateJoinMs: number;
      readonly now: number;
    }
  /** Back after a reload or a drop, with the mode stored for this tab (Decision Q3). */
  | {
      readonly type: 'resumed';
      readonly groupIndex: number | null;
      readonly ownIndex: number;
      readonly storedMode: FollowMode;
    }
  /**
   * This tab led the group and leads no more (#25 architecture 8.2, U14):
   * on the group's page it follows; elsewhere (it was previewing) it is
   * browsing with no prompt until the next move.
   */
  | { readonly type: 'demoted'; readonly groupIndex: number | null; readonly ownIndex: number }
  | { readonly type: 'groupMoved'; readonly index: number; readonly ownIndex: number }
  | { readonly type: 'userTurned'; readonly ownIndex: number }
  | { readonly type: 'goToGroup' }
  | { readonly type: 'stayHere' }
  | { readonly type: 'lateExpired' };

export interface FollowStep {
  readonly state: FollowState;
  /** Move the page there (an app move). */
  readonly jumpTo: number | null;
}

const step = (state: FollowState, jumpTo: number | null = null): FollowStep => ({ state, jumpTo });

export function follow(state: FollowState, event: FollowEvent): FollowStep {
  switch (event.type) {
    case 'admitted': {
      const base = { ...INITIAL_FOLLOW, groupIndex: event.groupIndex };
      if (event.groupIndex === null || event.groupIndex === event.ownIndex) return step(base);
      if (event.fresh || event.lateJoinMs === 0) return step(base, event.groupIndex);
      return step({
        ...base,
        late: { index: event.groupIndex, deadline: event.now + event.lateJoinMs },
      });
    }
    case 'resumed': {
      const base = { ...INITIAL_FOLLOW, groupIndex: event.groupIndex };
      if (event.groupIndex === null) return step({ ...base, mode: event.storedMode });
      if (event.storedMode === 'browsing' && event.groupIndex !== event.ownIndex) {
        return step({ ...base, mode: 'browsing', jump: { index: event.groupIndex } });
      }
      return step(base, event.groupIndex === event.ownIndex ? null : event.groupIndex);
    }
    case 'demoted': {
      const base = { ...INITIAL_FOLLOW, groupIndex: event.groupIndex };
      if (event.groupIndex === null || event.groupIndex === event.ownIndex) return step(base);
      return step({ ...base, mode: 'browsing' });
    }
    case 'groupMoved': {
      const moved = { ...state, groupIndex: event.index };
      // During the countdown the page in the prompt updates, the deadline doesn't (F8).
      if (state.late !== null)
        return step({ ...moved, late: { ...state.late, index: event.index } });
      if (state.mode === 'following') return step(moved, event.index);
      if (event.index === event.ownIndex) return step({ ...moved, mode: 'following', jump: null });
      return step({ ...moved, jump: { index: event.index } });
    }
    case 'userTurned': {
      const late = null;
      if (state.groupIndex !== null && event.ownIndex === state.groupIndex) {
        return step({ ...state, late, mode: 'following', jump: null });
      }
      return step({ ...state, late, mode: 'browsing' });
    }
    case 'goToGroup': {
      const target = state.late?.index ?? state.groupIndex;
      return step({ ...state, mode: 'following', jump: null, late: null }, target);
    }
    case 'stayHere':
      return step({ ...state, mode: 'browsing', jump: null, late: null });
    case 'lateExpired':
      if (state.late === null) return step(state);
      return step({ ...state, mode: 'following', late: null, jump: null }, state.late.index);
  }
}
