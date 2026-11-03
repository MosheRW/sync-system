import { createHash } from 'node:crypto';
import { type DestinationStream, type Logger, pino } from 'pino';
import type { LogLevel } from '../config/env.js';

export type { Logger };

/*
 * Second line of defense: sensitive keys are removed if they ever reach the
 * logger, at ANY depth, including inside arrays, nested objects, class
 * instances, toJSON results and child logger bindings (#10 B1). The first
 * line is that call sites only log allowed fields (event, namespace,
 * groupRef, participantRef, codes such as error codes, counts, port). The
 * participantRef is always of the connection ID, never of a group-scoped
 * participant ID (L7).
 *
 * Keys are compared after normalization (lowercase, only a-z and 0-9), so
 * `displayName`, `display_name` and `DISPLAY-NAME` are the same key.
 */

/** Normalized keys that are removed when they match exactly. */
export const SENSITIVE_LOG_KEYS: ReadonlySet<string> = new Set([
  // Opaque app data (#1, #3) and raw frames.
  'position',
  'positions',
  'metadata',
  'payload',
  'body',
  // Network identity and raw HTTP requests.
  'ip',
  'ips',
  'ipaddress',
  'remoteaddress',
  'remoteip',
  'address',
  'forwarded',
  'forwardedfor',
  'xforwardedfor',
  'headers',
  'header',
  'req',
  'url',
  'query',
  // Free text that may carry input (#5); never a log field (R10).
  'reason',
  'message',
  // #10: the codes payload (R10).
  'codes',
  // Client-chosen free text the server echoes.
  'reqid',
  'appversion',
]);

/**
 * Normalized fragments: any key that contains one is removed, so plurals
 * and prefixed forms (`doorCodes`, `refreshToken`, `qrTicket`,
 * `pendingDisplayNames`) are covered without listing each one.
 */
export const SENSITIVE_LOG_KEY_PARTS: readonly string[] = [
  // Credentials (#1, #5 AC10).
  'apikey',
  'token',
  'secret',
  'password',
  'passwd',
  'credential',
  'privatekey',
  'signature',
  'authorization',
  'cookie',
  // Capabilities and group-scoped IDs (#5 L7; group IDs are join capabilities).
  'groupid',
  'participantid',
  'blocklist',
  // #10: display names, join codes, the codes blob, QR tickets, request IDs.
  'displayname',
  'joincode',
  'doorcode',
  'groupcode',
  'alphacode',
  'blob',
  'ticket',
  'requestid',
];

/** True when a log field with this name must never be written. */
export function isSensitiveLogKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SENSITIVE_LOG_KEYS.has(normalized)) return true;
  return SENSITIVE_LOG_KEY_PARTS.some((part) => normalized.includes(part));
}

/** Deeper values are replaced; log fields are a few levels deep at most. */
const MAX_LOG_DEPTH = 32;

/**
 * A copy of `value` without any sensitive key at any depth. Arrays are
 * walked item by item; errors become safeErr (never the message); objects
 * with toJSON are walked after toJSON, as JSON.stringify would see them;
 * cycles become '[Circular]'. The input is never mutated.
 */
export function redactLogValue(value: unknown): unknown {
  return redactWalk(value, new Set(), 0);
}

function redactWalk(value: unknown, ancestors: Set<object>, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return safeErr(value);
  if (ancestors.has(value)) return '[Circular]';
  if (depth >= MAX_LOG_DEPTH) return '[Truncated]';
  ancestors.add(value);
  try {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') {
      let json: unknown;
      try {
        json = (toJSON as () => unknown).call(value);
      } catch {
        return '[Unserializable]';
      }
      return json === value ? '[Circular]' : redactWalk(json, ancestors, depth + 1);
    }
    if (Array.isArray(value)) {
      return value.map((item: unknown) => redactWalk(item, ancestors, depth + 1));
    }
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (isSensitiveLogKey(key)) continue;
      result[key] = redactWalk((value as Record<string, unknown>)[key], ancestors, depth + 1);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function redactFields(value: object): Record<string, unknown> {
  if (value instanceof Error) return { err: safeErr(value) };
  return redactLogValue(value) as Record<string, unknown>;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Defaults to stdout. Tests inject a capturing stream. */
  destination?: DestinationStream;
}

export function createLogger(options: LoggerOptions): Logger {
  const logger = pino(
    {
      level: options.level,
      hooks: {
        /**
         * Redacts the fields before pino sees them, so an Error never turns
         * into `msg` (pino copies err.message), and drops every argument
         * after the message, so nothing is interpolated into it (`%s`).
         */
        logMethod(args, method) {
          const [first, second] = args as unknown[];
          if (first !== null && typeof first === 'object') {
            const fields = redactFields(first);
            if (typeof second === 'string') {
              method.call(this, fields, second);
            } else {
              method.call(this, fields);
            }
            return;
          }
          method.call(this, first as string);
        },
      },
      formatters: {
        // Backstop for anything that bypasses the hook (mixins).
        log: (fields) => redactFields(fields),
      },
    },
    options.destination ?? pino.destination({ dest: 1, sync: false }),
  );
  // Pino resets the bindings formatter for children, so child bindings are
  // redacted here. Children inherit this property through the prototype
  // chain, so grandchildren are covered too.
  // Read unbound on purpose: each child must call it with itself as `this`.
  type ChildFn = (this: unknown, bindings: object, childOptions?: unknown) => unknown;
  const pinoChild = Reflect.get(logger, 'child') as ChildFn;
  const safeChild: ChildFn = function child(this: unknown, bindings, childOptions) {
    return pinoChild.call(this, redactFields(bindings), childOptions);
  };
  Reflect.set(logger, 'child', safeChild);
  return logger;
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
