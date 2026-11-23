import type { RosterEntry } from '@mosherw/sync-system-react';
import type { Messages } from '../i18n/en.js';

/**
 * The leader's view of the roster (#25 architecture 7.1, design 6.1, 6.2).
 * Pure. Only the leader ever has a roster, so the `leader` entry is the
 * leader's own row.
 */

/**
 * The own row first, then everyone else in the roster's own order (the
 * server's admission order). Never re-sorted by state, role or `joinedAt`
 * (U10, D7: `joinedAt` jitters on every snapshot).
 */
export function orderRoster(roster: readonly RosterEntry[]): readonly RosterEntry[] {
  const own = roster.filter((entry) => entry.role === 'leader');
  return [...own, ...roster.filter((entry) => entry.role !== 'leader')];
}

export interface RosterCounts {
  /** Connected, not counting the leader (Q10). */
  readonly here: number;
  /** Not connected. Pending joiners are not on the roster. */
  readonly away: number;
}

export function countRoster(roster: readonly RosterEntry[]): RosterCounts {
  let here = 0;
  let away = 0;
  for (const entry of roster) {
    if (!entry.connected) away += 1;
    else if (entry.role !== 'leader') here += 1;
  }
  return { here, away };
}

/** The counter wording (design 6.1, Q10). */
export function counterKey(
  counts: RosterCounts,
): 'peopleCounter' | 'peopleCounterNoAway' | 'peopleCounterEmpty' {
  if (counts.here === 0 && counts.away === 0) return 'peopleCounterEmpty';
  return counts.away === 0 ? 'peopleCounterNoAway' : 'peopleCounter';
}

export type RowRole = 'leader' | 'vice' | 'member';

export function rowRole(entry: RosterEntry, viceId: string | null): RowRole {
  if (entry.role === 'leader') return 'leader';
  return viceId !== null && entry.participantId === viceId ? 'vice' : 'member';
}

/** Line 2 of a row: role, state and the "Auto name" tag (design 6.2). */
export function rowDetails(entry: RosterEntry, viceId: string | null, t: Messages): string[] {
  const role = { leader: t.roleLeader, vice: t.roleVice, member: t.roleMember }[
    rowRole(entry, viceId)
  ];
  const parts = [role, entry.connected ? t.stateHere : t.stateAway];
  if (entry.generated) parts.push(t.autoNameTag);
  return parts;
}
