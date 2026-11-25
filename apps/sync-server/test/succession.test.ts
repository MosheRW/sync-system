import { describe, expect, it } from 'vitest';
import type { GroupRecord } from '../src/groups/group-store.js';
import { type RosterState, admit, setConnected } from '../src/lifecycle/roster.js';
import { nextTerm, pickSuccessor, successorCandidates } from '../src/lifecycle/succession.js';

function record(names: string[], overrides: Partial<GroupRecord> = {}) {
  let state: RosterState = { roster: [], nextAdmissionSeq: 0, nextGuestNumber: 1 };
  for (const pid of names) state = admit(state, pid, { generated: true }, 0);
  return {
    leaderId: 'L',
    viceId: undefined,
    displacedLeaderId: undefined,
    roster: state.roster,
    blockList: [],
    participantIds: [...names],
    ...overrides,
  } as Pick<
    GroupRecord,
    'leaderId' | 'viceId' | 'displacedLeaderId' | 'roster' | 'blockList' | 'participantIds'
  >;
}

const all = () => true;

describe('nextTerm (#13 D3)', () => {
  it('is strictly above the previous term, never below the clock or the floor', () => {
    expect(nextTerm(100, 50)).toBe(101);
    expect(nextTerm(100, 500)).toBe(500);
    expect(nextTerm(100, 50, 1_000)).toBe(1_000);
    expect(nextTerm(2_000, 50, 1_000)).toBe(2_001);
  });
});

describe('pickSuccessor (#13 AC20, Q2.2, AC12)', () => {
  it('takes the connected vice first, else the earliest admitted connected member', () => {
    expect(pickSuccessor(record(['L', 'a', 'b', 'c'], { viceId: 'c' }), all)).toBe('c');
    expect(pickSuccessor(record(['L', 'a', 'b', 'c']), all)).toBe('a');
    expect(pickSuccessor(record(['L', 'a', 'b', 'c'], { viceId: 'c' }), (p) => p !== 'c')).toBe(
      'a',
    );
  });

  it('never picks the leader, the displaced leader, a blocked or detached participant', () => {
    expect(pickSuccessor(record(['L', 'a', 'b'], { displacedLeaderId: 'a' }), all)).toBe('b');
    expect(pickSuccessor(record(['L', 'a', 'b'], { blockList: ['a'] }), all)).toBe('b');
    const detached = record(['L', 'a', 'b']);
    expect(pickSuccessor({ ...detached, participantIds: ['L', 'b'] }, all)).toBe('b');
    const off = record(['L', 'a']);
    expect(pickSuccessor({ ...off, roster: setConnected(off.roster, 'a', false, 1) }, all)).toBe(
      undefined,
    );
    expect(pickSuccessor(record(['L']), all)).toBeUndefined();
  });
});

describe('successorCandidates (#42, security R2)', () => {
  it('lists the vice first, then the connected roster, with the pickSuccessor filters', () => {
    expect(successorCandidates(record(['L', 'a', 'b', 'c'], { viceId: 'c' }))).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(successorCandidates(record(['L', 'a', 'b']))).toEqual(['a', 'b']);
  });

  it('excludes the leader, the displaced leader, blocked, detached and disconnected pids', () => {
    const base = record(['L', 'a', 'b', 'c', 'd', 'e']);
    const view = {
      ...base,
      displacedLeaderId: 'a',
      blockList: ['b'],
      participantIds: base.participantIds.filter((pid) => pid !== 'c'),
      roster: setConnected(base.roster, 'd', false, 1),
    };
    expect(successorCandidates(view)).toEqual(['e']);
    expect(successorCandidates({ ...view, viceId: 'b' })).toEqual(['e']);
    expect(successorCandidates(record(['L']))).toEqual([]);
  });

  it('contains every pid pickSuccessor can pick, whatever isConnected says', () => {
    const view = record(['L', 'a', 'b', 'c'], { viceId: 'b', blockList: ['a'] });
    const candidates = successorCandidates(view);
    for (const pid of ['L', 'a', 'b', 'c']) {
      const picked = pickSuccessor(view, (p) => p === pid);
      if (picked !== undefined) expect(candidates).toContain(picked);
    }
    expect(pickSuccessor(view, (p) => candidates.includes(p))).toBe('b');
  });
});
