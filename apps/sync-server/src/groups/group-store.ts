import type { HandoffMode, JoinMethod, JsonObject, JsonValue } from '@sync-system/protocol';
import type { GroupCodes } from '../joins/codes.js';
import type { RosterEntry } from '../lifecycle/roster.js';

/** `has: false` is the explicit "no position yet", so `null` stays a real payload. */
export type StoredPosition = { has: false } | { has: true; payload: JsonValue };

export interface GroupRecord {
  /** 43-char base64url, 256 random bits. */
  id: string;
  appNamespace: string;
  /** Opaque, stored exactly as parsed; never read. */
  metadata: JsonObject;
  /** Opaque, stored exactly as parsed; never read. */
  position: StoredPosition;
  /** Group-scoped participant ID of the leader. */
  leaderId: string;
  /**
   * The leader (always, connected or not: its slot stays reserved while it is
   * offline) plus the attached members. Group-scoped participant IDs.
   */
  participantIds: string[];
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms of the leader's last activity (#5 AC12). */
  lastActivityAt: number;
  /**
   * Leadership term (#13 D3): epoch-ms based, only increases. Set to
   * `createdAt` on create, kept from the token on a recreation, and moved
   * by `nextTerm` on every grant. Every token carries it.
   */
  term: number;
  /**
   * Clock at the recreation of this group in this process (after a
   * restart), `max(now, claims.term + 1)` (#13 6.6.1, RC18); undefined for a
   * group created in this process. A group is recreated at most once per
   * process (#13 6.9).
   */
  recoveredAt: number | undefined;
  /**
   * The vice-leader (#13 AC10-AC13): a roster pid that is not the leader and
   * not blocked, or undefined. Kept over a disconnect; cleared when it
   * leaves, is removed or becomes leader.
   */
  viceId: string | undefined;
  /**
   * A running pause (#13 D8): `offline` iff the leader is not connected,
   * `inactive` after a missed keep-alive. `graceEndsAt` (epoch ms) only in
   * `auto` mode, when a handoff can follow. Undefined while live.
   */
  pause: GroupPause | undefined;
  /** A keep-alive prompt is outstanding (#13 6.3). */
  keepAlivePending: boolean;
  /**
   * The most recent displaced leader: the only one that may take back the
   * lead (#13 Q2.4). Never the leader; cleared when it leaves, is removed
   * or the group is recreated.
   */
  displacedLeaderId: string | undefined;
  /**
   * The leader got the lead through a missed-keep-alive handoff and has not
   * acted since (#13 D9, Q-B): its own missed keep-alive ends the group.
   */
  escalated: boolean;
  /** The leader locked the group: no new admission by any method (#13 AC29). */
  locked: boolean;
  /**
   * The term of the token that recreated the group, then of the latest
   * superseding token (#13 6.6.1); undefined iff `recoveredAt` is.
   * Invariant: `anchorTerm < recoveredAt`.
   */
  anchorTerm: number | undefined;
  /**
   * True from a recreation until the first supersede (#13 6.6.4): code, QR
   * and approval admissions meanwhile get `admittedSinceRecovery`.
   */
  recoveryMarking: boolean;
  /** `auto` hands off after the grace period; `frozen` never does (#13 AC3). */
  handoff: HandoffMode;
  /** False while the leader is offline: the group is frozen (#5 AC18). */
  leaderOnline: boolean;
  /** Blocked participant IDs (#5 AC26). Never logged. */
  blockList: readonly string[];
  /** The group's join methods, canonical order, never both A and B (#10 AC5). */
  joinMethods: readonly JoinMethod[];
  /** The group's join codes and generations (#10 AC6). Never logged. */
  codes: GroupCodes;
  /**
   * Every admitted participant in admission order, connected or not (#13
   * D10). Names and IDs: leader-only on the wire, never logged.
   */
  roster: readonly RosterEntry[];
  /** Admission order of the next roster entry. */
  nextAdmissionSeq: number;
  /** N of the next generated `Guest N` name. */
  nextGuestNumber: number;
}

/** A running pause of a group (#13 D8). */
export interface GroupPause {
  readonly cause: 'offline' | 'inactive';
  readonly graceEndsAt?: number;
  /**
   * Frozen mode only: when an empty group's hold ends (#13 Q-G, RC21 (b)).
   * Set once and never extended; in `auto` mode the hold uses `graceEndsAt`.
   */
  readonly holdEndsAt?: number;
}

/** The single deadline of a pause: the grace end (auto) or the hold end (frozen). */
export function pauseDeadline(pause: GroupPause | undefined): number | undefined {
  return pause?.graceEndsAt ?? pause?.holdEndsAt;
}

/** Record fields `patch` may set in one atomic step (#13 3.2). */
export type GroupPatch = Partial<Omit<GroupRecord, 'id' | 'appNamespace' | 'createdAt'>>;

/**
 * `ok` carries a snapshot of the group taken in the same atomic step as the
 * insert, so a join never needs a second read that could fail or race.
 */
export type AddParticipantResult =
  | { status: 'ok'; group: GroupRecord }
  | { status: 'not_found' }
  | { status: 'full' }
  | { status: 'blocked' };

/**
 * Group storage. Async and atomic per operation, so a Redis implementation
 * can provide the same semantics later. Groups are keyed by namespace + ID,
 * so a lookup across apps is impossible by construction (AC18). There is
 * deliberately no way to list groups (AC20).
 */
export interface GroupStore {
  create(group: GroupRecord): Promise<void>;
  /**
   * Stores `group` unless a group with its namespace and ID exists (#5
   * recreation, AC27). Atomic: two concurrent calls create one group.
   */
  createIfAbsent(group: GroupRecord): Promise<'created' | 'exists'>;
  /** A shallow copy (opaque values are shared, never mutated). */
  get(namespace: string, id: string): Promise<GroupRecord | undefined>;
  /**
   * Adds a participant unless the group is missing, the ID is on the block
   * list, or the group already has `maxSize`, and returns a snapshot of the
   * group that includes it (one atomic step).
   * Idempotent per participant ID: adding an ID that is already in the
   * group takes no extra slot.
   */
  addParticipant(
    namespace: string,
    id: string,
    participantId: string,
    maxSize: number,
  ): Promise<AddParticipantResult>;
  /**
   * Removes a member. `connected` is the number of participants still
   * connected afterwards: the attached members plus the leader if online.
   */
  removeParticipant(
    namespace: string,
    id: string,
    participantId: string,
  ): Promise<{ connected: number } | undefined>;
  /**
   * Marks the leader online or offline. Going online at `at` is a leader
   * activity (`lastActivityAt = at`). Returns the updated snapshot.
   */
  setLeaderOnline(
    namespace: string,
    id: string,
    online: boolean,
    at?: number,
  ): Promise<GroupRecord | undefined>;
  /** Stores a leader position; it is a leader activity at `at`. */
  setPosition(namespace: string, id: string, payload: JsonValue, at: number): Promise<boolean>;
  /**
   * Replaces the block list and removes the listed members from the group in
   * the same atomic step (#5 AC26). Returns the removed participant IDs.
   */
  setBlockList(
    namespace: string,
    id: string,
    blockList: readonly string[],
  ): Promise<{ removed: string[] } | undefined>;
  /**
   * Sets the given fields in one atomic step (#13: roster, leadership,
   * pause, lock, vice). Returns the updated snapshot, or undefined when the
   * group is not in memory.
   */
  patch(namespace: string, id: string, patch: GroupPatch): Promise<GroupRecord | undefined>;
  /** Replaces the group's join codes (#10 AC29, AC30). Returns the updated snapshot. */
  setCodes(namespace: string, id: string, codes: GroupCodes): Promise<GroupRecord | undefined>;
  delete(namespace: string, id: string): Promise<void>;
}

/** Participants connected to `record`: attached members plus the leader if online. */
export function connectedCount(record: GroupRecord): number {
  const members = record.participantIds.filter((id) => id !== record.leaderId).length;
  return members + (record.leaderOnline ? 1 : 0);
}
