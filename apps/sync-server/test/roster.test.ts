import { describe, expect, it } from 'vitest';
import {
  type RosterEntry,
  type RosterState,
  admit,
  evictOverflow,
  generateGuestName,
  remove,
  roleOf,
  setConnected,
  toWire,
} from '../src/lifecycle/roster.js';

const EMPTY: RosterState = { roster: [], nextAdmissionSeq: 0, nextGuestNumber: 1 };

function build(...names: Array<string | undefined>): RosterState {
  let state = EMPTY;
  names.forEach((name, i) => {
    state = admit(
      state,
      `p${i}`,
      name === undefined ? { generated: true } : { generated: false, name },
      1_000 + i,
    );
  });
  return state;
}

describe('roster (#13 D10, D11)', () => {
  it('admits in order with sequence numbers and Guest N for missing names', () => {
    const state = build('Dana', undefined, undefined);
    expect(state.roster.map((e) => [e.pid, e.name, e.generated, e.admittedSeq])).toEqual([
      ['p0', 'Dana', false, 0],
      ['p1', 'Guest 1', true, 1],
      ['p2', 'Guest 2', true, 2],
    ]);
    expect(state.roster[1]?.guestNumber).toBe(1);
    expect(state.nextAdmissionSeq).toBe(3);
    expect(state.nextGuestNumber).toBe(3);
  });

  it('skips a Guest N that a chosen name already uses, so generated names are unique', () => {
    const state = build('Guest 1', 'Guest 2', undefined);
    expect(state.roster[2]).toMatchObject({ name: 'Guest 3', guestNumber: 3, generated: true });
    expect(generateGuestName(state.roster, state.nextGuestNumber)).toMatchObject({
      name: 'Guest 4',
    });
  });

  it('allows duplicate chosen names (Q5.2)', () => {
    const state = build('Dana', 'Dana');
    expect(state.roster.map((e) => e.name)).toEqual(['Dana', 'Dana']);
  });

  it('marks entries disconnected and connected again without losing their place', () => {
    const state = build('A', 'B');
    const off = setConnected(state.roster, 'p1', false, 5_000);
    expect(off[1]).toMatchObject({ connected: false, disconnectedAt: 5_000, admittedSeq: 1 });
    const on = setConnected(off, 'p1', true, 6_000);
    expect(on[1]).toEqual({ ...state.roster[1], connected: true });
    expect(remove(on, ['p0']).map((e) => e.pid)).toEqual(['p1']);
  });

  it('evicts the first-disconnected entry past the cap, never a protected one (RC10, M3)', () => {
    let roster: RosterEntry[] = [...build('L', 'A', 'B', 'C', 'D').roster];
    roster = setConnected(roster, 'p1', false, 10);
    roster = setConnected(roster, 'p2', false, 20);
    roster = setConnected(roster, 'p3', false, 30);
    // Cap 2: one must go; p1 disconnected first.
    expect(evictOverflow(roster, 2, ['p0']).evicted).toEqual(['p1']);
    // p1 protected (the take-back holder or the vice): the next oldest goes.
    expect(evictOverflow(roster, 2, ['p0', 'p1']).evicted).toEqual(['p2']);
    // Both protected and the cap exceeded only by them.
    expect(evictOverflow(roster, 1, ['p0', 'p1', 'p2']).evicted).toEqual(['p3']);
    expect(evictOverflow(roster, 3, ['p0']).evicted).toEqual([]);
  });

  it('derives roles from the record and sends durations only (D12)', () => {
    const [leader, vice, member] = build('L', 'V', undefined).roster as RosterEntry[];
    const record = { leaderId: 'p0', viceId: 'p1' };
    expect(roleOf(record, 'p0')).toBe('leader');
    expect(roleOf(record, 'p1')).toBe('vice-leader');
    expect(roleOf(record, 'p2')).toBe('member');
    expect(toWire(leader!, record, 1_500)).toEqual({
      participantId: 'p0',
      displayName: 'L',
      generated: false,
      role: 'leader',
      connected: true,
      joinedAgoMs: 500,
    });
    expect(toWire(member!, record, 1_002)).toMatchObject({ guestNumber: 1, joinedAgoMs: 0 });
    // The recovery marker shows only once a supersede happened (6.6.4).
    const flagged = { ...vice!, admittedSinceRecovery: true };
    expect(toWire(flagged, { ...record, recoveryMarking: true }, 2_000)).not.toHaveProperty(
      'admittedSinceRecovery',
    );
    expect(toWire(flagged, { ...record, recoveryMarking: false }, 2_000)).toMatchObject({
      admittedSinceRecovery: true,
    });
  });
});
