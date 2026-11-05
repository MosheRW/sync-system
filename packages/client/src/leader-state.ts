import type { LeaderState, RosterEntryWire } from '@sync-system/protocol';
import { now } from './host.js';
import type { RosterEntry } from './state.js';

/**
 * Leader-only data of the group this client leads (#13 AC31, D13): the
 * roster and the recovery state. Names and IDs of possibly minors: kept in
 * memory only while this client leads, dropped on every demotion and on
 * removal (L4, RC12), and never logged.
 */
export class LeaderData {
  #groupId: string | undefined;
  readonly #roster = new Map<string, RosterEntry>();
  #state: LeaderState | undefined;

  /** The group the data is for, or undefined when this client leads none. */
  get groupId(): string | undefined {
    return this.#groupId;
  }

  /** Starts over for `groupId` with the server's recovery state. */
  reset(groupId: string, state: LeaderState): void {
    this.#groupId = groupId;
    this.#roster.clear();
    this.#state = copyState(state);
  }

  /** Drops everything (demotion, removal, end, close). */
  clear(): void {
    this.#groupId = undefined;
    this.#roster.clear();
    this.#state = undefined;
  }

  /** The recovery state, frozen, or null. */
  state(): LeaderState | null {
    return this.#state === undefined ? null : Object.freeze(copyState(this.#state));
  }

  /** Patches the recovery state (vice, lock, block list). */
  patchState(patch: Partial<LeaderState>): void {
    if (this.#state === undefined) return;
    const next: LeaderState = { ...this.#state, ...patch };
    if ('viceId' in patch && patch.viceId === undefined) delete next.viceId;
    this.#state = copyState(next);
  }

  /** Replaces the roster with a snapshot. */
  snapshot(groupId: string, participants: readonly RosterEntryWire[]): boolean {
    if (groupId !== this.#groupId) return false;
    this.#roster.clear();
    for (const entry of participants) this.#roster.set(entry.participantId, toEntry(entry));
    return true;
  }

  /** Adds or replaces one entry. */
  update(groupId: string, entry: RosterEntryWire): boolean {
    if (groupId !== this.#groupId) return false;
    this.#roster.set(entry.participantId, toEntry(entry));
    return true;
  }

  /** Removes one entry. */
  remove(groupId: string, participantId: string): boolean {
    if (groupId !== this.#groupId) return false;
    return this.#roster.delete(participantId);
  }

  /** The roster in admission order, frozen. */
  roster(): readonly RosterEntry[] {
    return Object.freeze([...this.#roster.values()]);
  }
}

function copyState(state: LeaderState): LeaderState {
  const copy: LeaderState = {
    blockList: [...state.blockList],
    locked: state.locked,
    handoff: state.handoff,
  };
  if (state.viceId !== undefined) copy.viceId = state.viceId;
  return copy;
}

/** A roster entry with a local join time from the server's duration (#13 D12). */
function toEntry(wire: RosterEntryWire): RosterEntry {
  return Object.freeze({
    participantId: wire.participantId,
    displayName: wire.displayName,
    generated: wire.generated,
    ...(wire.guestNumber === undefined ? {} : { guestNumber: wire.guestNumber }),
    role: wire.role,
    connected: wire.connected,
    joinedAt: now() - wire.joinedAgoMs,
    ...(wire.admittedSinceRecovery === true ? { admittedSinceRecovery: true as const } : {}),
  });
}
