import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { type DestinationStream, type Logger, pino } from 'pino';
import {
  ALPHA_CODE_PATTERN,
  CODES_BLOB_PATTERN,
  GROUP_CODE_PATTERN,
  QR_TICKET_PATTERN,
} from '@sync-system/protocol';
import type { LogLevel } from '../config/env.js';

export type { Logger };

/*
 * Second line of defense: sensitive keys are removed if they ever reach the
 * logger, at ANY depth, including inside arrays, nested objects, class
 * instances, toJSON results and child logger bindings (#10 B1). The first
 * line is that call sites only log allowed fields (event, namespace,
 * groupRef, participantRef, errorCode, closeCode, safeErr, counts, port). The
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
  // pino's own message key: a field named `msg` would be written as a
  // second message. The real message (the string argument) is added by pino
  // after the fields are redacted, so it is kept.
  'msg',
  // Ambiguous: a `code` could be a join code and a `name` a display name.
  // Call sites log `errorCode`, `closeCode` or `err: safeErr(err)` instead;
  // safeErr's own `name` and `code` are kept (see redactWalk).
  'code',
  'name',
  // #10: the codes payload (R10).
  'codes',
  // Client-chosen free text the server echoes.
  'reqid',
  'appversion',
  // #13 M2, RC9: group-scoped IDs and names under the role and roster keys.
  'pid',
  'pids',
  'successor',
  'target',
  'targetid',
  'roster',
  'participants',
  'participant',
  'guestnumber',
  'names',
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
  // #13 M2, RC9: `leaderId`, `displacedLeaderId`, `viceId` and their kin.
  'leaderid',
  'viceid',
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
  if (typeof value === 'string') return looksLikeJoinSecret(value) ? REDACTED : value;
  if (value === null || typeof value !== 'object') return value;
  if (isError(value)) return safeErr(value);
  if (SAFE_ERRORS.has(value)) return value;
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

/** Replaces a string value that has the shape of a join secret. */
const REDACTED = '[Redacted]';

/**
 * Value-shape backstop: a group code, an alpha code, a QR ticket or a codes
 * blob is removed under ANY key, so a join code logged under an innocuous
 * name never reaches a log line. Request IDs are covered by key only: their
 * shape (22 base64url characters) could also be a legitimate namespace.
 */
function looksLikeJoinSecret(value: string): boolean {
  return (
    GROUP_CODE_PATTERN.test(value) ||
    ALPHA_CODE_PATTERN.test(value) ||
    (value.length <= MAX_SECRET_SHAPE_LENGTH &&
      (QR_TICKET_PATTERN.test(value) || CODES_BLOB_PATTERN.test(value)))
  );
}

/** Longer strings are not tested against the ticket and blob shapes. */
const MAX_SECRET_SHAPE_LENGTH = 4096;

function redactFields(value: object): Record<string, unknown> {
  if (isError(value)) return { err: safeErr(value) };
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
  // redacted here, and so are bindings set later with setBindings (C2).
  // Children inherit both properties through the prototype chain, so
  // grandchildren are covered too.
  // Read unbound on purpose: each child must call them with itself as `this`.
  type ChildFn = (this: unknown, bindings: object, childOptions?: unknown) => unknown;
  type SetBindingsFn = (this: unknown, bindings: object) => void;
  const pinoChild = Reflect.get(logger, 'child') as ChildFn;
  const pinoSetBindings: SetBindingsFn = Reflect.get(logger, 'setBindings');
  const safeChild: ChildFn = function child(this: unknown, bindings, childOptions) {
    return pinoChild.call(this, redactFields(bindings), safeChildOptions(childOptions));
  };
  const safeSetBindings: SetBindingsFn = function setBindings(this: unknown, bindings) {
    pinoSetBindings.call(this, redactFields(bindings));
  };
  Reflect.set(logger, 'child', safeChild);
  Reflect.set(logger, 'setBindings', safeSetBindings);
  return logger;
}

/**
 * Only the level is forwarded from child options. The others could write
 * unredacted text (`msgPrefix`) or replace the redaction (`serializers`,
 * `formatters`, `redact`), so they are dropped (C2).
 */
function safeChildOptions(childOptions: unknown): { level: string } | undefined {
  if (childOptions === null || typeof childOptions !== 'object') return undefined;
  const level = (childOptions as { level?: unknown }).level;
  return typeof level === 'string' ? { level } : undefined;
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
  if (!isError(err)) {
    return remember({ name: typeof err, frames: [] });
  }
  const result: SafeError = {
    name: err.name,
    frames: stackFrames(err),
  };
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') result.code = code;
  return remember(result);
}

/**
 * safeErr results, which the walker passes through whole: their `name` and
 * `code` are an error's, not input, although both keys are removed
 * everywhere else. They are frozen so nothing can be added to them later.
 */
const SAFE_ERRORS = new WeakSet<object>();

function remember(result: SafeError): SafeError {
  Object.freeze(result.frames);
  SAFE_ERRORS.add(Object.freeze(result));
  return result;
}

/** An error from this realm or another one (vm contexts, workers). */
function isError(value: unknown): value is Error {
  return value instanceof Error || types.isNativeError(value);
}

/**
 * The stack frames of an error, without its header. V8 writes the stack as
 * a header (`<name>: <message>`, or `<name> [<code>]: <message>` for Node
 * errors) and then one `    at ...` line per frame, so a multi-line message
 * that contains `\n    at <input>` would look like a frame. The header is
 * skipped first, up to the end of the message, then only frame lines are
 * kept (C3). When the message is not found in the stack (it was changed
 * after the stack was written, or the stack was replaced), no frame is
 * trusted.
 */
function stackFrames(err: Error): string[] {
  const stack = typeof err.stack === 'string' ? err.stack : '';
  const message = typeof err.message === 'string' ? err.message : '';
  let afterMessage = 0;
  if (message.length > 0) {
    const start = stack.indexOf(message);
    if (start < 0) return [];
    afterMessage = start + message.length;
  }
  const headerEnd = stack.indexOf('\n', afterMessage);
  if (headerEnd < 0) return [];
  return stack
    .slice(headerEnd + 1)
    .split('\n')
    .filter((line) => /^\s+at /.test(line))
    .map((line) => line.trim());
}
