import { z } from 'zod';
import { ErrorCode } from './errors.js';
import { buildJitless } from './jitless.js';
import {
  ALPHA_CODE_PATTERN,
  CODES_BLOB_PATTERN,
  GROUP_CODE_PATTERN,
  JOIN_METHODS,
  JOIN_REQUEST_ID_PATTERN,
} from './join.js';
import type { JsonObject, JsonValue } from './json.js';
import {
  HANDOFF_MODES,
  MAX_API_KEY_LENGTH,
  MAX_APP_VERSION_INPUT_LENGTH,
  MAX_BLOCK_LIST_SIZE,
  MAX_CODES_BLOB_LENGTH,
  MAX_DISPLAY_NAME_INPUT_LENGTH,
  MAX_JOIN_CODE_INPUT_LENGTH,
  MAX_QR_TICKET_INPUT_LENGTH,
  MAX_QR_TICKET_LENGTH,
  MAX_REQ_ID_LENGTH,
  MAX_TOKEN_LENGTH,
  MAX_TOKENS_PER_CHECK,
  NAMESPACE_PATTERN,
  PARTICIPANT_ID_PATTERN,
} from './limits.js';
import {
  type ClientMessage,
  GROUP_ENDED_REASONS,
  type ServerMessage,
  TOKEN_STATUSES,
} from './messages.js';

/**
 * Most entries a `roster.snapshot` may carry: twice the largest group size a
 * client accepts (10 000), plus the protected entries (#13 D10).
 */
const MAX_ROSTER_WIRE_ENTRIES = 20_002;

// Every schema below is built with zod's `jitless` option on. Without it,
// building the first z.object runs zod's eval probe at import time: it reads
// the browser global `navigator` and calls `new Function("")`, which a strict
// CSP reports even though zod catches the error. Importing this package (and
// the client, which depends on it) must read no browser global and never eval
// (#3 AC7). The option is process-global in zod and is read when a schema is
// built, so it is switched on only while these schemas are built, then the
// previous value is put back, even if building throws (`buildJitless`):
// other zod schemas in the same process keep their own setting. These
// schemas use zod's interpreted parser, which is slower than the generated
// one; protocol frames are small, so this does not matter next to network
// and JSON costs.
const schemas = buildJitless(() => {
  // Opaque values (position, metadata) are never rebuilt by a schema: z.custom
  // returns the parsed reference unchanged, so `__proto__` keys and deep values
  // pass through untouched (M4, L6). JSON types and depth are checked separately
  // and iteratively by `checkJson`.

  /** Any value that is present (JSON cannot produce `undefined`). */
  const opaqueValue = z.custom<JsonValue>((value) => value !== undefined);

  /** A non-array, non-null object, passed through by reference. */
  const opaqueObject = z.custom<JsonObject>(
    (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  );

  const reqId = z.string().max(MAX_REQ_ID_LENGTH).optional();

  const helloSchema = z.object({
    type: z.literal('hello'),
    reqId,
    protocolVersion: z.number().int(),
    appVersion: z.string().max(MAX_APP_VERSION_INPUT_LENGTH),
    apiKey: z.string().max(MAX_API_KEY_LENGTH).optional(),
  });

  /** 1 to 4 method letters; duplicates are the server's JOIN_METHOD_NOT_ALLOWED (#10 AC5). */
  const joinMethodList = z.array(z.enum(JOIN_METHODS)).min(1).max(JOIN_METHODS.length);

  const groupCreateSchema = z.object({
    type: z.literal('group.create'),
    reqId,
    metadata: opaqueObject,
    position: opaqueValue.optional(),
    joinMethods: joinMethodList.optional(),
    handoff: z.enum(HANDOFF_MODES).optional(),
    displayName: z.string().max(MAX_DISPLAY_NAME_INPUT_LENGTH).optional(),
  });

  const joinCode = z.string().max(MAX_JOIN_CODE_INPUT_LENGTH);
  const displayName = z.string().max(MAX_DISPLAY_NAME_INPUT_LENGTH);

  // Lengths only: normalization and the code formats are checked by the
  // server after the join budgets (#10 architecture 4.3).
  const groupJoinByCodeSchema = z.object({
    type: z.literal('group.joinByCode'),
    reqId,
    joinCode,
    doorCode: joinCode.optional(),
    displayName: displayName.optional(),
  });

  // The ticket shape is checked by the server, so a bad ticket gets QR_INVALID (#10 AC25).
  const groupJoinByQrSchema = z.object({
    type: z.literal('group.joinByQr'),
    reqId,
    ticket: z.string().max(MAX_QR_TICKET_INPUT_LENGTH),
    displayName: displayName.optional(),
  });

  const qrIssueSchema = z.object({ type: z.literal('qr.issue'), reqId });

  const positionUpdateSchema = z.object({
    type: z.literal('position.update'),
    reqId,
    position: opaqueValue,
  });

  const inboundToken = z.string().max(MAX_TOKEN_LENGTH);

  /** Participant IDs: at most 256, each in the participant ID format (#5 AC24). */
  const blockList = z.array(z.string().regex(PARTICIPANT_ID_PATTERN)).max(MAX_BLOCK_LIST_SIZE);

  const groupResumeSchema = z.object({
    type: z.literal('group.resume'),
    reqId,
    token: inboundToken,
    metadata: opaqueObject.optional(),
    position: opaqueValue.optional(),
    blockList: blockList.optional(),
    // The blob is checked by the server; a bad one only means new codes (#10 AC33).
    joinCodes: z.string().max(MAX_CODES_BLOB_LENGTH).optional(),
    // Leader recovery state (#13 D13); used only for a recreation.
    handoff: z.enum(HANDOFF_MODES).optional(),
    viceId: z.string().regex(PARTICIPANT_ID_PATTERN).optional(),
    locked: z.boolean().optional(),
    displayName: displayName.optional(),
  });

  const tokensCheckSchema = z.object({
    type: z.literal('tokens.check'),
    reqId,
    tokens: z.array(inboundToken).min(1).max(MAX_TOKENS_PER_CHECK),
  });

  const blockListSetSchema = z.object({ type: z.literal('blocklist.set'), reqId, blockList });

  const groupEndSchema = z.object({ type: z.literal('group.end'), reqId });

  const groupLeaveSchema = z.object({ type: z.literal('group.leave'), reqId });

  const codesRotateSchema = z.object({ type: z.literal('codes.rotate'), reqId });

  const requestId = z.string().regex(JOIN_REQUEST_ID_PATTERN);

  const joinCancelSchema = z.object({ type: z.literal('join.cancel'), reqId });
  const joinApproveSchema = z.object({ type: z.literal('join.approve'), reqId, requestId });
  const joinDenySchema = z.object({ type: z.literal('join.deny'), reqId, requestId });

  const participantId = z.string().regex(PARTICIPANT_ID_PATTERN);
  const viceSetSchema = z.object({ type: z.literal('vice.set'), reqId, participantId });
  const viceClearSchema = z.object({ type: z.literal('vice.clear'), reqId });
  const groupLockSchema = z.object({ type: z.literal('group.lock'), reqId });
  const groupUnlockSchema = z.object({ type: z.literal('group.unlock'), reqId });
  const memberRemoveSchema = z.object({ type: z.literal('member.remove'), reqId, participantId });
  // No payload: unknown keys are stripped, so nothing sent with it is read (#13 AC30).
  const leaderActivitySchema = z.object({ type: z.literal('leader.activity'), reqId });
  const keepAliveAckSchema = z.object({ type: z.literal('keepalive.ack'), reqId });

  const clientMessageSchema = z.discriminatedUnion('type', [
    helloSchema,
    groupCreateSchema,
    groupJoinByCodeSchema,
    groupJoinByQrSchema,
    qrIssueSchema,
    positionUpdateSchema,
    groupResumeSchema,
    tokensCheckSchema,
    blockListSetSchema,
    groupEndSchema,
    groupLeaveSchema,
    codesRotateSchema,
    joinCancelSchema,
    joinApproveSchema,
    joinDenySchema,
    viceSetSchema,
    viceClearSchema,
    groupLockSchema,
    groupUnlockSchema,
    memberRemoveSchema,
    leaderActivitySchema,
    keepAliveAckSchema,
  ]);

  const appLimitsSchema = z.object({
    maxGroupSize: z.number().int().positive(),
    maxLeaderUpdatesPerSecond: z.number().int().positive(),
    maxMessageBytes: z.number().int().positive(),
    maxSessionMinutes: z.number().int().positive(),
    qrTicketSeconds: z.number().int().positive(),
    approvalTimeoutSeconds: z.number().int().positive(),
    inactivityLimitMinutes: z.number().int().positive(),
    disconnectGraceSeconds: z.number().int().positive(),
    keepAliveCountdownSeconds: z.number().int().positive(),
  });

  const joinMethods = joinMethodList;

  const joinCodesPayload = z.object({
    generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    groupCode: z.string().regex(GROUP_CODE_PATTERN).optional(),
    doorCode: z.string().regex(GROUP_CODE_PATTERN).optional(),
    alphaCode: z.string().regex(ALPHA_CODE_PATTERN).optional(),
    blob: z.string().max(MAX_CODES_BLOB_LENGTH).regex(CODES_BLOB_PATTERN),
  });

  const token = z.string().min(1).max(MAX_TOKEN_LENGTH);

  /** The receiver's own name (#13 AC36). */
  const ownName = {
    displayName: z.string().max(MAX_DISPLAY_NAME_INPUT_LENGTH),
    generated: z.boolean(),
  };

  const role = z.enum(['leader', 'vice-leader', 'member']);
  const leaderState = z.object({
    blockList,
    locked: z.boolean(),
    viceId: z.string().regex(PARTICIPANT_ID_PATTERN).optional(),
    handoff: z.enum(HANDOFF_MODES),
  });
  const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
  const rosterEntry = z.object({
    participantId: z.string().regex(PARTICIPANT_ID_PATTERN),
    displayName: z.string().max(MAX_DISPLAY_NAME_INPUT_LENGTH),
    generated: z.boolean(),
    guestNumber: count.optional(),
    role,
    connected: z.boolean(),
    joinedAgoMs: count,
    admittedSinceRecovery: z.literal(true).optional(),
  });

  const groupJoinedBase = {
    ...ownName,
    type: z.literal('group.joined'),
    reqId,
    groupId: z.string(),
    participantId: z.string(),
    role: z.literal('member'),
    metadata: opaqueObject,
    token,
    leaderOnline: z.boolean(),
    locked: z.boolean(),
  };

  const groupResumedBase = {
    ...ownName,
    type: z.literal('group.resumed'),
    reqId,
    groupId: z.string(),
    participantId: z.string(),
    role: z.literal('leader'),
    metadata: opaqueObject,
    token,
    recreated: z.boolean(),
    joinMethods: joinMethodList,
    codes: joinCodesPayload,
    codesChanged: z.boolean(),
    state: leaderState,
  };

  const serverMessageSchema = z.union([
    z.object({
      type: z.literal('welcome'),
      protocolVersion: z.number().int(),
      minProtocolVersion: z.number().int(),
    }),
    z.object({
      type: z.literal('hello.ok'),
      reqId,
      participantId: z.string(),
      namespace: z.string().regex(NAMESPACE_PATTERN),
      joinMethods,
      limits: appLimitsSchema,
      defaultHandoff: z.enum(HANDOFF_MODES),
    }),
    z.object({
      type: z.literal('group.created'),
      reqId,
      groupId: z.string(),
      participantId: z.string(),
      role: z.literal('leader'),
      handoff: z.enum(HANDOFF_MODES),
      state: leaderState,
      ...ownName,
      token,
      joinMethods,
      codes: joinCodesPayload,
    }),
    z.object({ ...groupJoinedBase, hasPosition: z.literal(true), position: opaqueValue }),
    z.object({ ...groupJoinedBase, hasPosition: z.literal(false) }),
    z.object({ ...groupResumedBase, hasPosition: z.literal(true), position: opaqueValue }),
    z.object({ ...groupResumedBase, hasPosition: z.literal(false) }),
    z.object({ type: z.literal('group.waiting'), reqId, groupId: z.string() }),
    z.object({
      type: z.literal('tokens.result'),
      reqId,
      results: z
        .array(z.object({ status: z.enum(TOKEN_STATUSES), token: token.optional() }))
        .max(MAX_TOKENS_PER_CHECK),
    }),
    z.object({ type: z.literal('position.ack'), reqId }),
    z.object({ type: z.literal('position.updated'), groupId: z.string(), position: opaqueValue }),
    z.object({
      type: z.literal('group.ended'),
      reqId,
      groupId: z.string(),
      reason: z.enum(GROUP_ENDED_REASONS),
    }),
    z.object({ type: z.literal('group.left'), reqId, groupId: z.string() }),
    z.object({ type: z.literal('blocklist.ack'), reqId }),
    z.object({ type: z.literal('token.refreshed'), groupId: z.string(), token }),
    z.object({ type: z.literal('leader.offline'), groupId: z.string() }),
    z.object({ type: z.literal('leader.online'), groupId: z.string() }),
    z.object({
      type: z.literal('codes.updated'),
      reqId,
      groupId: z.string(),
      reason: z.enum(['rotated', 'door_failures', 'member_removed']),
      codes: joinCodesPayload,
    }),
    z.object({
      type: z.literal('join.paused'),
      groupId: z.string(),
      retryAfterMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
    z.object({ type: z.literal('join.resumed'), groupId: z.string() }),
    z.object({
      type: z.literal('join.pending'),
      reqId,
      requestId: z.string(),
      timeoutMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
    z.object({
      type: z.literal('join.requested'),
      groupId: z.string(),
      requestId: z.string(),
      expiresInMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      displayName: z.string().max(MAX_DISPLAY_NAME_INPUT_LENGTH).optional(),
    }),
    z.object({
      type: z.literal('join.withdrawn'),
      groupId: z.string(),
      requestId: z.string(),
      reason: z.enum(['cancelled', 'disconnected', 'timeout']),
    }),
    z.object({
      type: z.literal('join.decided'),
      reqId,
      requestId: z.string(),
      outcome: z.enum(['admitted', 'group_full', 'denied']),
    }),
    z.object({ type: z.literal('join.cancelled'), reqId, requestId: z.string() }),
    z.object({
      type: z.literal('qr.ticket'),
      reqId,
      ticket: z.string().min(1).max(MAX_QR_TICKET_LENGTH),
      expiresInMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }),
    z.object({
      type: z.literal('roster.snapshot'),
      groupId: z.string(),
      // Bounded by the group size ceiling of any server (MAX_ROSTER_ENTRIES_FACTOR).
      participants: z.array(rosterEntry).max(MAX_ROSTER_WIRE_ENTRIES),
    }),
    z.object({ type: z.literal('roster.updated'), groupId: z.string(), participant: rosterEntry }),
    z.object({
      type: z.literal('roster.removed'),
      groupId: z.string(),
      participantId: z.string().regex(PARTICIPANT_ID_PATTERN),
    }),
    z.object({
      type: z.literal('vice.updated'),
      reqId,
      groupId: z.string(),
      viceId: z.string().regex(PARTICIPANT_ID_PATTERN).nullable(),
    }),
    z.object({ type: z.literal('vice.changed'), groupId: z.string(), isVice: z.boolean() }),
    z.object({ type: z.literal('lock.changed'), reqId, groupId: z.string(), locked: z.boolean() }),
    z.object({ type: z.literal('activity.ack'), reqId }),
    z.object({
      type: z.literal('keepalive.prompt'),
      groupId: z.string(),
      countdownMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
    z.object({ type: z.literal('keepalive.cleared'), groupId: z.string() }),
    z.object({
      type: z.literal('member.removed'),
      reqId,
      groupId: z.string(),
      participantId: z.string().regex(PARTICIPANT_ID_PATTERN),
      blockList,
    }),
    z.object({
      type: z.literal('error'),
      reqId,
      code: z.enum(ErrorCode),
      message: z.string(),
      details: z.record(z.string(), opaqueValue).optional(),
    }),
  ]);

  return {
    helloSchema,
    groupCreateSchema,
    positionUpdateSchema,
    groupResumeSchema,
    clientMessageSchema,
    serverMessageSchema,
  };
});

export const helloSchema = schemas.helloSchema;
export const groupCreateSchema = schemas.groupCreateSchema;
export const positionUpdateSchema = schemas.positionUpdateSchema;
export const groupResumeSchema = schemas.groupResumeSchema;
export const clientMessageSchema = schemas.clientMessageSchema;
export const serverMessageSchema = schemas.serverMessageSchema;

export type ParseResult<T> = { ok: true; message: T } | { ok: false; issues: string[] };

/**
 * Formats zod issues as `path: code` only. Received values are never echoed,
 * so an API key or a payload can never end up in an error message.
 */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    return `${path}: ${issue.code}`;
  });
}

/** Validates the envelope of an already JSON-parsed client frame. */
export function parseClientMessage(value: unknown): ParseResult<ClientMessage> {
  const result = clientMessageSchema.safeParse(value);
  if (result.success) {
    return { ok: true, message: result.data };
  }
  return { ok: false, issues: formatIssues(result.error) };
}

/** Validates the envelope of an already JSON-parsed server frame. */
export function parseServerMessage(value: unknown): ParseResult<ServerMessage> {
  const result = serverMessageSchema.safeParse(value);
  if (result.success) {
    return { ok: true, message: result.data };
  }
  return { ok: false, issues: formatIssues(result.error) };
}
