import type { JsonObject, JsonValue } from '@sync-system/protocol';

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
  leaderId: string;
  /** Includes the leader. */
  participantIds: string[];
  /** Epoch ms. */
  createdAt: number;
}

/**
 * `ok` carries a snapshot of the group taken in the same atomic step as the
 * insert, so a join never needs a second read that could fail or race.
 */
export type AddParticipantResult =
  { status: 'ok'; group: GroupRecord } | { status: 'not_found' } | { status: 'full' };

/**
 * Group storage. Async and atomic per operation, so a Redis implementation
 * can provide the same semantics later. Groups are keyed by namespace + ID,
 * so a lookup across apps is impossible by construction (AC18). There is
 * deliberately no way to list groups (AC20).
 */
export interface GroupStore {
  create(group: GroupRecord): Promise<void>;
  /** A shallow copy (opaque values are shared, never mutated). */
  get(namespace: string, id: string): Promise<GroupRecord | undefined>;
  /**
   * Adds a participant unless the group is missing or already has `maxSize`,
   * and returns a snapshot of the group that includes it (one atomic step).
   */
  addParticipant(
    namespace: string,
    id: string,
    participantId: string,
    maxSize: number,
  ): Promise<AddParticipantResult>;
  removeParticipant(
    namespace: string,
    id: string,
    participantId: string,
  ): Promise<{ remaining: number } | undefined>;
  setPosition(namespace: string, id: string, payload: JsonValue): Promise<boolean>;
  delete(namespace: string, id: string): Promise<void>;
}
