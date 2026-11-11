import type { RosterEntry } from '@sync-system/react';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en.js';
import { he } from '../src/i18n/he.js';
import { format } from '../src/i18n/index.js';
import { isolateName, rosterNameText } from '../src/group/names.js';
import {
  countRoster,
  counterKey,
  orderRoster,
  rowDetails,
  rowRole,
} from '../src/group/roster-view.js';

function entry(id: string, extra: Partial<RosterEntry> = {}): RosterEntry {
  return {
    participantId: id,
    displayName: id,
    generated: false,
    role: 'member',
    connected: true,
    joinedAt: 0,
    ...extra,
  };
}

describe('roster order and counts (#25 AC38, U10, D7)', () => {
  it('puts the own (leader) row first, then keeps the array order, ignoring joinedAt', () => {
    const roster = [
      entry('b', { joinedAt: 500 }),
      entry('me', { role: 'leader', joinedAt: 900 }),
      entry('a', { joinedAt: 100, connected: false }),
      entry('c', { joinedAt: 50 }),
    ];
    expect(orderRoster(roster).map((e) => e.participantId)).toEqual(['me', 'b', 'a', 'c']);
  });

  it('counts here (connected, not the leader) and away', () => {
    const roster = [
      entry('me', { role: 'leader' }),
      entry('a'),
      entry('b', { connected: false }),
      entry('c'),
    ];
    expect(countRoster(roster)).toEqual({ here: 2, away: 1 });
    expect(counterKey({ here: 2, away: 1 })).toBe('peopleCounter');
    expect(counterKey({ here: 2, away: 0 })).toBe('peopleCounterNoAway');
    expect(counterKey({ here: 0, away: 0 })).toBe('peopleCounterEmpty');
    expect(counterKey({ here: 0, away: 2 })).toBe('peopleCounter');
    expect(countRoster([entry('me', { role: 'leader' })])).toEqual({ here: 0, away: 0 });
    expect(countRoster([])).toEqual({ here: 0, away: 0 });
  });

  it('reads role, state and the Auto name tag for line 2', () => {
    expect(rowRole(entry('me', { role: 'leader' }), 'me')).toBe('leader');
    expect(rowRole(entry('v'), 'v')).toBe('vice');
    expect(rowRole(entry('m'), null)).toBe('member');
    expect(rowDetails(entry('v', { generated: true }), 'v', en)).toEqual([
      'Vice-leader',
      'Here',
      'Auto name',
    ]);
    expect(rowDetails(entry('m', { connected: false }), null, he)).toEqual(['משתתף', 'לא כאן']);
  });
});

describe('roster names (#25 AC39, D6)', () => {
  const en1 = (template: string, values: Record<string, string | number>) =>
    format('en', template, values);
  const he1 = (template: string, values: Record<string, string | number>) =>
    format('he', template, values);

  it('localises a generated name from guestNumber, never by matching the text', () => {
    const generated = entry('g', { generated: true, displayName: 'Guest 3', guestNumber: 3 });
    expect(rosterNameText(generated, en, en1)).toBe('Guest 3');
    expect(rosterNameText(generated, he, he1)).toBe('אורח 3');
    const noNumber = entry('g', { generated: true, displayName: 'Guest 9' });
    expect(rosterNameText(noNumber, en, en1)).toBe('Guest');
    expect(rosterNameText(noNumber, he, he1)).toBe('אורח');
  });

  it('shows a chosen name verbatim, also one that looks generated', () => {
    for (const name of ['Guest 3', '<b>x</b>', '{n}', 'דנה (Dana)']) {
      expect(rosterNameText(entry('c', { displayName: name }), he, he1)).toBe(name);
    }
  });

  it('isolates a name for announcements and drops its bidi controls (R15, L1)', () => {
    expect(isolateName('Dana')).toBe('⁨Dana⁩');
    expect(isolateName('‮evil⁩x‏')).toBe('⁨evilx⁩');
  });
});
