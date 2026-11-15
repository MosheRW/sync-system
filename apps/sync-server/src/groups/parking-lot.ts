import type { Cancel, Scheduler } from '../time/scheduler.js';
import type { NameChoice } from '../lifecycle/roster.js';
import type { Session } from './session.js';

interface Parked {
  session: Session;
  cancel: Cancel;
  /** The display name the member sent with its resume (#13 AC37). */
  name: NameChoice;
}

/**
 * Members waiting for their leader to recreate a group that is not in memory
 * (Q7, AC25). Keyed by group and by group-scoped participant ID, so one
 * participant has at most one parked session (M5), and a session is parked
 * for at most one group. Each entry has an expiry timer. Process-local.
 */
export class ParkingLot {
  /** groupKey -> participantId -> entry, in arrival order. */
  private readonly groups = new Map<string, Map<string, Parked>>();

  constructor(private readonly scheduler: Scheduler) {}

  /** Number of parked sessions. For tests only. */
  get size(): number {
    let total = 0;
    for (const entries of this.groups.values()) total += entries.size;
    return total;
  }

  /**
   * Parks `session` for `groupKey` as `participantId` until `until`, when
   * `onExpire` runs. Returns the older session parked as the same
   * participant, which is unparked (newest wins, M5), if any.
   */
  park(
    session: Session,
    groupKey: string,
    groupId: string,
    participantId: string,
    until: number,
    onExpire: () => void,
    name: NameChoice = { generated: true },
  ): Session | undefined {
    const older = this.groups.get(groupKey)?.get(participantId);
    if (older !== undefined) this.unpark(older.session);
    let entries = this.groups.get(groupKey);
    if (entries === undefined) {
      entries = new Map();
      this.groups.set(groupKey, entries);
    }
    session.parked = { groupKey, groupId, participantId };
    entries.set(participantId, { session, cancel: this.scheduler.at(until, onExpire), name });
    return older?.session;
  }

  /** Unparks `session` if it is parked. Returns whether it was. */
  unpark(session: Session): boolean {
    const parked = session.parked;
    if (parked === undefined) return false;
    session.parked = undefined;
    const entries = this.groups.get(parked.groupKey);
    const entry = entries?.get(parked.participantId);
    if (entries === undefined || entry === undefined || entry.session !== session) return true;
    entry.cancel();
    entries.delete(parked.participantId);
    if (entries.size === 0) this.groups.delete(parked.groupKey);
    return true;
  }

  /**
   * Unparks and returns every session parked for `groupKey` with the
   * participant ID it was parked as, in arrival order.
   */
  drain(groupKey: string): Array<{ session: Session; participantId: string; name: NameChoice }> {
    const entries = this.groups.get(groupKey);
    if (entries === undefined) return [];
    const drained = [...entries].map(([participantId, entry]) => ({
      session: entry.session,
      participantId,
      name: entry.name,
    }));
    for (const { session } of drained) this.unpark(session);
    return drained;
  }

  /** Whether any session is parked for `groupKey`. */
  has(groupKey: string): boolean {
    return (this.groups.get(groupKey)?.size ?? 0) > 0;
  }

  /** Cancels every expiry timer and forgets every entry (server shutdown). */
  clearAll(): void {
    for (const entries of this.groups.values()) {
      for (const entry of entries.values()) {
        entry.cancel();
        entry.session.parked = undefined;
      }
    }
    this.groups.clear();
  }
}
