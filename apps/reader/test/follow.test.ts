import { describe, expect, it } from 'vitest';
import { type FollowState, INITIAL_FOLLOW, follow } from '../src/group/follow.js';

const admitted = (
  groupIndex: number | null,
  ownIndex: number,
  fresh: boolean,
  lateJoinMs = 10_000,
) =>
  follow(INITIAL_FOLLOW, { type: 'admitted', groupIndex, ownIndex, fresh, lateJoinMs, now: 1000 });

const browsing: FollowState = { ...INITIAL_FOLLOW, mode: 'browsing', groupIndex: 3 };

describe('follow reducer (#24 architecture 7.2)', () => {
  it('admits: no position, same page, fresh, zero countdown, late (AC28, U1)', () => {
    expect(admitted(null, 2, false)).toEqual({ state: INITIAL_FOLLOW, jumpTo: null });
    expect(admitted(2, 2, false).jumpTo).toBeNull();
    expect(admitted(6, 0, true)).toEqual({
      state: { ...INITIAL_FOLLOW, groupIndex: 6 },
      jumpTo: 6,
    });
    expect(admitted(6, 2, false, 0).jumpTo).toBe(6);
    expect(admitted(6, 2, false)).toEqual({
      state: { ...INITIAL_FOLLOW, groupIndex: 6, late: { index: 6, deadline: 11_000 } },
      jumpTo: null,
    });
  });

  it('follows the leader while following (AC25)', () => {
    expect(
      follow({ ...INITIAL_FOLLOW, groupIndex: 1 }, { type: 'groupMoved', index: 2, ownIndex: 1 })
        .jumpTo,
    ).toBe(2);
  });

  it('prompts a browsing member with the latest page, never moving them (AC26)', () => {
    const first = follow(browsing, { type: 'groupMoved', index: 4, ownIndex: 0 });
    expect(first).toEqual({
      state: { ...browsing, groupIndex: 4, jump: { index: 4 } },
      jumpTo: null,
    });
    const second = follow(first.state, { type: 'groupMoved', index: 5, ownIndex: 0 });
    expect(second.state.jump).toEqual({ index: 5 });
    expect(second.jumpTo).toBeNull();
    // The leader came to the member's page: following again, prompt gone.
    expect(follow(second.state, { type: 'groupMoved', index: 0, ownIndex: 0 }).state).toMatchObject(
      {
        mode: 'following',
        jump: null,
      },
    );
  });

  it('turns: browsing, or following again on the group page (AC31)', () => {
    const following = { ...INITIAL_FOLLOW, groupIndex: 3 };
    expect(follow(following, { type: 'userTurned', ownIndex: 4 }).state.mode).toBe('browsing');
    expect(follow(browsing, { type: 'userTurned', ownIndex: 3 }).state).toMatchObject({
      mode: 'following',
      jump: null,
    });
  });

  it('Go to page, Stay here', () => {
    const prompted = { ...browsing, jump: { index: 3 } };
    expect(follow(prompted, { type: 'goToGroup' })).toEqual({
      state: { ...browsing, mode: 'following', jump: null },
      jumpTo: 3,
    });
    expect(follow(prompted, { type: 'stayHere' }).state).toMatchObject({
      mode: 'browsing',
      jump: null,
    });
  });

  it('runs the late countdown: leader moves update the page, not the deadline (F8)', () => {
    const { state } = admitted(6, 2, false);
    const moved = follow(state, { type: 'groupMoved', index: 7, ownIndex: 2 });
    expect(moved).toEqual({
      state: { ...state, groupIndex: 7, late: { index: 7, deadline: 11_000 } },
      jumpTo: null,
    });
    expect(follow(moved.state, { type: 'lateExpired' })).toMatchObject({
      jumpTo: 7,
      state: { late: null, mode: 'following' },
    });
    expect(follow(moved.state, { type: 'goToGroup' }).jumpTo).toBe(7);
    expect(follow(moved.state, { type: 'userTurned', ownIndex: 3 }).state).toMatchObject({
      late: null,
      mode: 'browsing',
    });
    expect(follow(moved.state, { type: 'stayHere' }).state).toMatchObject({
      late: null,
      mode: 'browsing',
    });
  });

  it('resumes per the stored mode (Decision Q3)', () => {
    expect(
      follow(INITIAL_FOLLOW, {
        type: 'resumed',
        groupIndex: 5,
        ownIndex: 2,
        storedMode: 'browsing',
      }),
    ).toEqual({
      state: { ...INITIAL_FOLLOW, mode: 'browsing', groupIndex: 5, jump: { index: 5 } },
      jumpTo: null,
    });
    expect(
      follow(INITIAL_FOLLOW, {
        type: 'resumed',
        groupIndex: 5,
        ownIndex: 2,
        storedMode: 'following',
      }).jumpTo,
    ).toBe(5);
  });
});
