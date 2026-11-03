import {
  MAX_CODES_BLOB_LENGTH,
  MAX_DISPLAY_NAME_INPUT_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_JOIN_CODE_INPUT_LENGTH,
  MAX_QR_TICKET_LENGTH,
} from './limits.js';

/**
 * The PRD join methods (#10):
 * - `A`: 6-digit group code plus 6-digit door code;
 * - `B`: 6-digit group code, then the leader approves;
 * - `C`: one 8-character alphanumeric code;
 * - `D`: a signed QR ticket with an expiry.
 */
export type JoinMethod = 'A' | 'B' | 'C' | 'D';

/** Every JoinMethod, in canonical order. */
export const JOIN_METHODS = ['A', 'B', 'C', 'D'] as const satisfies readonly JoinMethod[];

/**
 * The 31 characters of an alphanumeric code (method C): digits and uppercase
 * letters without the look-alikes 0, O, 1, I and L (AC8).
 */
export const ALPHA_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Length of a group code and of a door code. */
export const GROUP_CODE_LENGTH = 6;

/** Length of an alphanumeric code. */
export const ALPHA_CODE_LENGTH = 8;

/** A normalized group code or door code: exactly 6 decimal digits (AC7). */
export const GROUP_CODE_PATTERN = /^[0-9]{6}$/;

/** A normalized alphanumeric code: 8 characters of ALPHA_CODE_ALPHABET (AC8). */
export const ALPHA_CODE_PATTERN = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;

/** A QR ticket: `payload.signature`, both base64url, signature 43 characters. */
export const QR_TICKET_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

/** A signed codes blob, same compact shape as a QR ticket. */
export const CODES_BLOB_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

/** A join request ID: 16 random bytes in base64url. */
export const JOIN_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** What a normalized join code is, by its format. */
export type JoinCodeKind = 'group' | 'alpha';

/**
 * Normalizes a typed join code (AC12): removes every space and hyphen and
 * uppercases ASCII letters. Other characters are kept, so the result still
 * fails the format check. Input longer than MAX_JOIN_CODE_INPUT_LENGTH is
 * returned unchanged; it can never match a code format.
 */
export function normalizeJoinCode(raw: string): string {
  if (raw.length > MAX_JOIN_CODE_INPUT_LENGTH) return raw;
  return raw.replace(/[ -]/g, '').replace(/[a-z]/g, (letter) => letter.toUpperCase());
}

/**
 * The kind of a normalized code: `group` for 6 digits (method A or B),
 * `alpha` for 8 alphabet characters (method C), else undefined.
 */
export function classifyJoinCode(normalized: string): JoinCodeKind | undefined {
  if (GROUP_CODE_PATTERN.test(normalized)) return 'group';
  if (ALPHA_CODE_PATTERN.test(normalized)) return 'alpha';
  return undefined;
}

/** True when a normalized door code has the door-code format (6 digits). */
export function isDoorCode(normalized: string): boolean {
  return GROUP_CODE_PATTERN.test(normalized);
}

/** True when `value` has the shape of a QR ticket (length first, then pattern). */
export function isQrTicketShape(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_QR_TICKET_LENGTH &&
    QR_TICKET_PATTERN.test(value)
  );
}

/** True when `value` has the shape of a codes blob (length first, then pattern). */
export function isCodesBlobShape(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_CODES_BLOB_LENGTH &&
    CODES_BLOB_PATTERN.test(value)
  );
}

/** A lone high or low surrogate: the string is not well-formed UTF-16. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Characters a display name may not contain (AC20, architecture 4.5, R9):
 * control characters, line and paragraph separators, bidi overrides and
 * isolates, and invisible format characters that could hide or reorder text
 * in the leader's prompt. ZWJ (U+200D), variation selectors and emoji tag
 * characters stay allowed, so emoji sequences work.
 */
const FORBIDDEN_NAME_CHARACTERS =
  /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\u061C\u200B\u200E\u200F\uFEFF]/u;

/**
 * Validates and trims an optional display name (AC20). Returns the trimmed
 * name, or undefined when it is not acceptable: over the raw input cap, not
 * well-formed UTF-16, empty after trimming, longer than 32 code points, or
 * containing a forbidden character. Server and client run this same
 * function, so both accept exactly the same names.
 */
export function normalizeDisplayName(raw: string): string | undefined {
  if (raw.length > MAX_DISPLAY_NAME_INPUT_LENGTH) return undefined;
  if (LONE_SURROGATE.test(raw)) return undefined;
  const trimmed = raw.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > MAX_DISPLAY_NAME_LENGTH) return undefined;
  if (FORBIDDEN_NAME_CHARACTERS.test(trimmed)) return undefined;
  return trimmed;
}
