import type { Role, RosterEntryWire } from '@sync-system/protocol';

/**
 * One admitted participant of a group (#13 D10, AC31). In memory only, for
 * the life of the participant in the group; never logged, never in a token.
 * Entries survive a disconnect (`connected: false`), so admission order
 * (Q2.2), the vice designation and names survive reconnects.
 */
export interface RosterEntry {
  /** Group-scoped participant ID. */
  readonly pid: string;
  /** The display name: chosen (strict #10 rule) or generated `Guest N`. */
  readonly name: string;
  readonly generated: boolean;
  /** The N of a generated `Guest N`, so apps can localize it. */
  readonly guestNumber?: number;
  /** Admission order in the group, from 0 (the creator). */
  readonly admittedSeq: number;
  /** Epoch ms of the admission. */
  readonly admittedAt: number;
  readonly connected: boolean;
  /** Epoch ms of the last disconnect while disconnected; picks the eviction victim. */
  readonly disconnectedAt?: number;
  /** Admitted by code, QR or approval while a recovered group was not yet superseded (#13 6.6.4). */
  readonly admittedSinceRecovery: boolean;
}

/** Fields of a group record the roster functions read and write. */
export interface RosterState {
  roster: readonly RosterEntry[];
  nextAdmissionSeq: number;
  nextGuestNumber: number;
}

/** A display name after `resolveDisplayName`: chosen, or to be generated. */
export type NameChoice = { generated: false; name: string } | { generated: true };

/** Prefix of a generated name. Locale-neutral; apps localize with `guestNumber` (Q5.1). */
const GUEST_NAME_PREFIX = 'Guest ';

/**
 * The next generated name (#13 D11): `Guest N` with N counting up from the
 * group's next guest number, skipping any N whose text equals a chosen
 * name on the roster, so a generated name is unique in the group.
 */
export function generateGuestName(
  roster: readonly RosterEntry[],
  nextGuestNumber: number,
): { name: string; guestNumber: number; next: number } {
  const chosen = new Set(roster.filter((e) => !e.generated).map((e) => e.name));
  let guestNumber = nextGuestNumber;
  while (chosen.has(`${GUEST_NAME_PREFIX}${guestNumber}`)) guestNumber += 1;
  return { name: `${GUEST_NAME_PREFIX}${guestNumber}`, guestNumber, next: guestNumber + 1 };
}

/**
 * Adds a new entry at the end of the roster (admission order), connected.
 * Returns the new roster state and the entry.
 */
export function admit(
  state: RosterState,
  pid: string,
  name: NameChoice,
  now: number,
  admittedSinceRecovery = false,
): RosterState & { entry: RosterEntry } {
  let nextGuestNumber = state.nextGuestNumber;
  let entry: RosterEntry;
  const base = {
    pid,
    admittedSeq: state.nextAdmissionSeq,
    admittedAt: now,
    connected: true,
    admittedSinceRecovery,
  };
  if (name.generated) {
    const guest = generateGuestName(state.roster, nextGuestNumber);
    nextGuestNumber = guest.next;
    entry = { ...base, name: guest.name, generated: true, guestNumber: guest.guestNumber };
  } else {
    entry = { ...base, name: name.name, generated: false };
  }
  return {
    roster: [...state.roster.filter((e) => e.pid !== pid), entry],
    nextAdmissionSeq: state.nextAdmissionSeq + 1,
    nextGuestNumber,
    entry,
  };
}

/** The entry of `pid`, if any. */
export function find(roster: readonly RosterEntry[], pid: string): RosterEntry | undefined {
  return roster.find((e) => e.pid === pid);
}

/** Marks `pid` connected or disconnected; unchanged when it has no entry. */
export function setConnected(
  roster: readonly RosterEntry[],
  pid: string,
  connected: boolean,
  now: number,
): RosterEntry[] {
  return roster.map((e) => {
    if (e.pid !== pid) return e;
    if (connected) {
      const rest: RosterEntry = { ...e, connected: true };
      delete (rest as { disconnectedAt?: number }).disconnectedAt;
      return rest;
    }
    return { ...e, connected: false, disconnectedAt: now };
  });
}

/** Removes the entries of `pids` (leave, removal, block list, group end). */
export function remove(roster: readonly RosterEntry[], pids: Iterable<string>): RosterEntry[] {
  const gone = new Set(pids);
  return roster.filter((e) => !gone.has(e.pid));
}

/**
 * Keeps at most `maxDisconnected` disconnected entries (#13 D10, RC10): past
 * that, the entry that disconnected first goes. The leader, the vice-leader
 * and the take-back holder (`protectedPids`) are never evicted; the next
 * oldest goes instead, so the cap can be exceeded by those entries only.
 */
export function evictOverflow(
  roster: readonly RosterEntry[],
  maxDisconnected: number,
  protectedPids: ReadonlyArray<string | undefined>,
): { roster: RosterEntry[]; evicted: string[] } {
  const keep = new Set(protectedPids.filter((p): p is string => p !== undefined));
  const disconnected = roster.filter((e) => !e.connected);
  const excess = disconnected.length - maxDisconnected;
  if (excess <= 0) return { roster: [...roster], evicted: [] };
  const candidates = disconnected
    .filter((e) => !keep.has(e.pid))
    .sort(
      (a, b) => (a.disconnectedAt ?? 0) - (b.disconnectedAt ?? 0) || a.admittedSeq - b.admittedSeq,
    );
  const evicted = candidates.slice(0, excess).map((e) => e.pid);
  return { roster: remove(roster, evicted), evicted };
}

/** What `toWire` needs to know about the group. */
export interface RoleSource {
  leaderId: string;
  viceId?: string | undefined;
  /** False until a supersede happened: the recovery marker is not shown before (#13 6.6.4). */
  recoveryMarking?: boolean;
}

/** The role of `pid` in the live record. */
export function roleOf(record: RoleSource, pid: string): Role {
  if (pid === record.leaderId) return 'leader';
  if (record.viceId !== undefined && pid === record.viceId) return 'vice-leader';
  return 'member';
}

/** The leader-only wire form of an entry (#13 5.2). Durations, never clock times (D12). */
export function toWire(entry: RosterEntry, record: RoleSource, now: number): RosterEntryWire {
  const wire: RosterEntryWire = {
    participantId: entry.pid,
    displayName: entry.name,
    generated: entry.generated,
    role: roleOf(record, entry.pid),
    connected: entry.connected,
    joinedAgoMs: Math.max(0, now - entry.admittedAt),
  };
  if (entry.guestNumber !== undefined) wire.guestNumber = entry.guestNumber;
  if (entry.admittedSinceRecovery && record.recoveryMarking === false) {
    wire.admittedSinceRecovery = true;
  }
  return wire;
}
