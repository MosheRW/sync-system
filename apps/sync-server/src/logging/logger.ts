import { createHash } from 'node:crypto';
import { type DestinationStream, type Logger, pino } from 'pino';
import type { LogLevel } from '../config/env.js';

export type { Logger };

/**
 * Second line of defense: these keys are removed if they ever reach the
 * logger. The first line is that call sites only log allowed fields
 * (event, namespace, groupRef, participantRef, codes, counts, port). The
 * participantRef is always of the connection ID, never of a group-scoped
 * participant ID (L7).
 */
export const REDACT_PATHS = [
  'apiKey',
  '*.apiKey',
  'position',
  '*.position',
  'metadata',
  '*.metadata',
  'ip',
  'remoteAddress',
  'headers',
  'req',
  'displayName',
  '*.displayName',
  'reason',
  'message',
  // #5: tokens, group-scoped participant IDs, block lists and secrets (AC10).
  'token',
  '*.token',
  'tokens',
  '*.tokens',
  'blockList',
  '*.blockList',
  'participantId',
  '*.participantId',
  'secret',
  '*.secret',
  // #10: join codes and the signed codes blob (R10). More paths are added
  // with each field that can carry a code, ticket or request ID.
  'codes',
  '*.codes',
  'joinCodes',
  '*.joinCodes',
  'blob',
  '*.blob',
];

export interface LoggerOptions {
  level: LogLevel;
  /** Defaults to stdout. Tests inject a capturing stream. */
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      redact: { paths: REDACT_PATHS, remove: true },
    },
    options.destination ?? pino.destination({ dest: 1, sync: false }),
  );
}

function ref(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

/** Group IDs are join capabilities; logs only ever see this hash prefix. */
export function groupRef(groupId: string): string {
  return ref(groupId);
}

export function participantRef(participantId: string): string {
  return ref(participantId);
}

export interface SafeError {
  name: string;
  code?: string;
  frames: string[];
}

/**
 * Describes an error without its message, which may contain input fragments
 * (L5): the name, a string `code` if present, and the stack frames only.
 */
export function safeErr(err: unknown): SafeError {
  if (!(err instanceof Error)) {
    return { name: typeof err, frames: [] };
  }
  const result: SafeError = {
    name: err.name,
    frames: (err.stack ?? '')
      .split('\n')
      .filter((line) => /^\s+at /.test(line))
      .map((line) => line.trim()),
  };
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') result.code = code;
  return result;
}
