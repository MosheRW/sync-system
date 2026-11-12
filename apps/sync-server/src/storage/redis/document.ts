import {
  GROUP_ID_PATTERN,
  HANDOFF_MODES,
  JOIN_METHODS,
  type JsonObject,
  type JsonValue,
  NAMESPACE_PATTERN,
} from '@sync-system/protocol';
import { z } from 'zod';
import type { GroupRecord, StoredPosition } from '../../groups/group-store.js';
import type { DoorState } from '../../joins/door-guard.js';

/**
 * The stored group, in two keys (#35 architecture 4.1, F10): the document
 * (every record field but the position and the last activity, plus the door
 * state) and the small position key. Both are checked with zod on every
 * read (architecture 4.3, security C1): a value that fails is never treated
 * as missing, so it can never lead to a recreation over it.
 */

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().min(1).max(64);
const jsonObject = z.custom<JsonObject>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
);

const rosterEntry = z.object({
  pid: id,
  name: z.string().max(256),
  generated: z.boolean(),
  guestNumber: count.optional(),
  admittedSeq: count,
  admittedAt: time,
  connected: z.boolean(),
  disconnectedAt: time.optional(),
  admittedSinceRecovery: z.boolean(),
});

const codes = z.object({
  generation: count,
  ticketGeneration: count,
  groupCode: z.string().optional(),
  doorCode: z.string().optional(),
  alphaCode: z.string().optional(),
});

const pause = z.object({
  cause: z.enum(['offline', 'inactive']),
  graceEndsAt: time.optional(),
  holdEndsAt: time.optional(),
});

const record = z.object({
  id: z.string().regex(GROUP_ID_PATTERN),
  appNamespace: z.string().regex(NAMESPACE_PATTERN),
  metadata: jsonObject,
  leaderId: id,
  participantIds: z.array(id),
  createdAt: time,
  term: time,
  recoveredAt: time.optional(),
  viceId: id.optional(),
  pause: pause.optional(),
  keepAlivePending: z.boolean(),
  displacedLeaderId: id.optional(),
  escalated: z.boolean(),
  locked: z.boolean(),
  anchorTerm: time.optional(),
  recoveryMarking: z.boolean(),
  handoff: z.enum(HANDOFF_MODES),
  leaderOnline: z.boolean(),
  blockList: z.array(id),
  joinMethods: z.array(z.enum(JOIN_METHODS)),
  codes,
  roster: z.array(rosterEntry),
  nextAdmissionSeq: count,
  nextGuestNumber: count,
});

const door = z.object({
  failures: count,
  rotations: z.array(time),
  pausedUntil: time.optional(),
});

const documentSchema = z.object({ v: z.literal(1), record, door: door.optional() });

const positionSchema = z.object({
  at: time,
  position: z.union([
    z.object({ has: z.literal(false) }),
    z.object({ has: z.literal(true), payload: z.unknown() }),
  ]),
});

export interface StoredGroup {
  record: GroupRecord;
  door: DoorState | undefined;
}

/** The document text of a group (record without position and last activity, plus door). */
export function encodeDocument(group: GroupRecord, doorState: DoorState | undefined): string {
  // A fixed field order, so an unchanged group encodes to the same text and
  // is not written again (F10). Opaque values keep their own order.
  const g = group;
  const fields = {
    id: g.id,
    appNamespace: g.appNamespace,
    metadata: g.metadata,
    leaderId: g.leaderId,
    participantIds: g.participantIds,
    createdAt: g.createdAt,
    term: g.term,
    recoveredAt: g.recoveredAt,
    viceId: g.viceId,
    pause:
      g.pause === undefined
        ? undefined
        : {
            cause: g.pause.cause,
            graceEndsAt: g.pause.graceEndsAt,
            holdEndsAt: g.pause.holdEndsAt,
          },
    keepAlivePending: g.keepAlivePending,
    displacedLeaderId: g.displacedLeaderId,
    escalated: g.escalated,
    locked: g.locked,
    anchorTerm: g.anchorTerm,
    recoveryMarking: g.recoveryMarking,
    handoff: g.handoff,
    leaderOnline: g.leaderOnline,
    blockList: g.blockList,
    joinMethods: g.joinMethods,
    codes: {
      generation: g.codes.generation,
      ticketGeneration: g.codes.ticketGeneration,
      groupCode: g.codes.groupCode,
      doorCode: g.codes.doorCode,
      alphaCode: g.codes.alphaCode,
    },
    roster: g.roster.map((e) => ({
      pid: e.pid,
      name: e.name,
      generated: e.generated,
      guestNumber: e.guestNumber,
      admittedSeq: e.admittedSeq,
      admittedAt: e.admittedAt,
      connected: e.connected,
      disconnectedAt: e.disconnectedAt,
      admittedSinceRecovery: e.admittedSinceRecovery,
    })),
    nextAdmissionSeq: g.nextAdmissionSeq,
    nextGuestNumber: g.nextGuestNumber,
  };
  const door =
    doorState === undefined
      ? undefined
      : {
          failures: doorState.failures,
          rotations: doorState.rotations,
          pausedUntil: doorState.pausedUntil,
        };
  return JSON.stringify({ v: 1, record: fields, door });
}

/** The position key text: the position and the leader's last activity. */
export function encodePosition(group: GroupRecord): string {
  return JSON.stringify({ at: group.lastActivityAt, position: group.position });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The group from its two stored texts, or `invalid` (wrong shape, wrong
 * group, unparsable, or only one of the two keys present).
 */
export function decodeGroup(
  namespace: string,
  groupId: string,
  documentText: string,
  positionText: string | undefined,
): StoredGroup | 'invalid' {
  if (positionText === undefined) return 'invalid';
  const doc = documentSchema.safeParse(parseJson(documentText));
  const pos = positionSchema.safeParse(parseJson(positionText));
  if (!doc.success || !pos.success) return 'invalid';
  const fields = doc.data.record;
  if (fields.id !== groupId || fields.appNamespace !== namespace) return 'invalid';
  const position: StoredPosition = pos.data.position.has
    ? { has: true, payload: pos.data.position.payload as JsonValue }
    : { has: false };
  const group: GroupRecord = {
    ...fields,
    position,
    lastActivityAt: pos.data.at,
    recoveredAt: fields.recoveredAt,
    viceId: fields.viceId,
    pause: fields.pause,
    displacedLeaderId: fields.displacedLeaderId,
    anchorTerm: fields.anchorTerm,
    roster: fields.roster,
  };
  return { record: group, door: doc.data.door };
}
