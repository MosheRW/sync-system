import { z } from 'zod';
import { ErrorCode } from './errors.js';
import { buildJitless } from './jitless.js';
import {
  ALPHA_CODE_PATTERN,
  CODES_BLOB_PATTERN,
  GROUP_CODE_PATTERN,
  JOIN_METHODS,
} from './join.js';
import type { JsonObject, JsonValue } from './json.js';
import {
  MAX_API_KEY_LENGTH,
  MAX_APP_VERSION_INPUT_LENGTH,
  MAX_BLOCK_LIST_SIZE,
  MAX_CODES_BLOB_LENGTH,
  MAX_DISPLAY_NAME_INPUT_LENGTH,
  MAX_JOIN_CODE_INPUT_LENGTH,
  MAX_GROUP_ID_INPUT_LENGTH,
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
  });

  const groupJoinSchema = z.object({
    type: z.literal('group.join'),
    reqId,
    groupId: z.string().max(MAX_GROUP_ID_INPUT_LENGTH),
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

  const clientMessageSchema = z.discriminatedUnion('type', [
    helloSchema,
    groupCreateSchema,
    groupJoinSchema,
    groupJoinByCodeSchema,
    positionUpdateSchema,
    groupResumeSchema,
    tokensCheckSchema,
    blockListSetSchema,
    groupEndSchema,
    groupLeaveSchema,
    codesRotateSchema,
  ]);

  const appLimitsSchema = z.object({
    maxGroupSize: z.number().int().positive(),
    maxLeaderUpdatesPerSecond: z.number().int().positive(),
    maxMessageBytes: z.number().int().positive(),
    maxSessionMinutes: z.number().int().positive(),
    qrTicketSeconds: z.number().int().positive(),
    approvalTimeoutSeconds: z.number().int().positive(),
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

  const groupJoinedBase = {
    type: z.literal('group.joined'),
    reqId,
    groupId: z.string(),
    participantId: z.string(),
    role: z.literal('member'),
    metadata: opaqueObject,
    token,
    leaderOnline: z.boolean(),
  };

  const groupResumedBase = {
    type: z.literal('group.resumed'),
    reqId,
    groupId: z.string(),
    participantId: z.string(),
    role: z.literal('leader'),
    metadata: opaqueObject,
    token,
    recreated: z.boolean(),
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
    }),
    z.object({
      type: z.literal('group.created'),
      reqId,
      groupId: z.string(),
      participantId: z.string(),
      role: z.literal('leader'),
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
      reason: z.enum(['rotated', 'door_failures']),
      codes: joinCodesPayload,
    }),
    z.object({
      type: z.literal('join.paused'),
      groupId: z.string(),
      retryAfterMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }),
    z.object({ type: z.literal('join.resumed'), groupId: z.string() }),
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
    groupJoinSchema,
    positionUpdateSchema,
    groupResumeSchema,
    clientMessageSchema,
    serverMessageSchema,
  };
});

export const helloSchema = schemas.helloSchema;
export const groupCreateSchema = schemas.groupCreateSchema;
export const groupJoinSchema = schemas.groupJoinSchema;
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
