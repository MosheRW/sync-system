import { z } from 'zod';
import { ErrorCode } from './errors.js';
import type { JsonObject, JsonValue } from './json.js';
import {
  MAX_API_KEY_LENGTH,
  MAX_APP_VERSION_INPUT_LENGTH,
  MAX_GROUP_ID_INPUT_LENGTH,
  MAX_REQ_ID_LENGTH,
} from './limits.js';
import type { ClientMessage, ServerMessage } from './messages.js';

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

export const helloSchema = z.object({
  type: z.literal('hello'),
  reqId,
  protocolVersion: z.number().int(),
  appVersion: z.string().max(MAX_APP_VERSION_INPUT_LENGTH),
  apiKey: z.string().max(MAX_API_KEY_LENGTH).optional(),
});

export const groupCreateSchema = z.object({
  type: z.literal('group.create'),
  reqId,
  metadata: opaqueObject,
  position: opaqueValue.optional(),
});

export const groupJoinSchema = z.object({
  type: z.literal('group.join'),
  reqId,
  groupId: z.string().max(MAX_GROUP_ID_INPUT_LENGTH),
});

export const positionUpdateSchema = z.object({
  type: z.literal('position.update'),
  reqId,
  position: opaqueValue,
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  helloSchema,
  groupCreateSchema,
  groupJoinSchema,
  positionUpdateSchema,
]);

const appLimitsSchema = z.object({
  maxGroupSize: z.number().int().positive(),
  maxLeaderUpdatesPerSecond: z.number().int().positive(),
  maxMessageBytes: z.number().int().positive(),
});

const groupJoinedBase = {
  type: z.literal('group.joined'),
  reqId,
  groupId: z.string(),
  participantId: z.string(),
  role: z.literal('member'),
  metadata: opaqueObject,
};

export const serverMessageSchema = z.union([
  z.object({
    type: z.literal('welcome'),
    protocolVersion: z.number().int(),
    minProtocolVersion: z.number().int(),
  }),
  z.object({
    type: z.literal('hello.ok'),
    reqId,
    participantId: z.string(),
    limits: appLimitsSchema,
  }),
  z.object({
    type: z.literal('group.created'),
    reqId,
    groupId: z.string(),
    participantId: z.string(),
    role: z.literal('leader'),
  }),
  z.object({ ...groupJoinedBase, hasPosition: z.literal(true), position: opaqueValue }),
  z.object({ ...groupJoinedBase, hasPosition: z.literal(false) }),
  z.object({ type: z.literal('position.ack'), reqId }),
  z.object({ type: z.literal('position.updated'), groupId: z.string(), position: opaqueValue }),
  z.object({
    type: z.literal('group.ended'),
    groupId: z.string(),
    reason: z.literal('leader_disconnected'),
  }),
  z.object({
    type: z.literal('error'),
    reqId,
    code: z.enum(ErrorCode),
    message: z.string(),
    details: z.record(z.string(), opaqueValue).optional(),
  }),
]);

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
