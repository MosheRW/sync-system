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

/**
 * Code points a display name may never contain (AC20, architecture 4.5, R9,
 * security review B2), chosen by Unicode property rather than by list, so
 * every character of a class is covered, including reserved ones:
 * - `Cc` control characters and `Cf` format characters (bidi controls,
 *   zero-width characters, interlinear annotation, invisible operators);
 * - `Cs` lone surrogates (the string is not well-formed UTF-16);
 * - `Co` private use and `Cn` unassigned code points (render unpredictably);
 * - `Zl` / `Zp` line and paragraph separators;
 * - `Default_Ignorable_Code_Point` (variation selectors, Hangul fillers,
 *   combining grapheme joiner, tags, and so on) and `Bidi_Control`;
 * - the few characters in visible categories that still render blank:
 *   U+2800 braille blank, the Hangul fillers U+115F, U+1160, U+3164,
 *   U+FFA0 (also default-ignorable) and U+1D159 musical null notehead.
 * Exception: the parts of emoji sequences, see EMOJI_SEQUENCE_PARTS.
 */
const FORBIDDEN_NAME_CHARACTER =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\u2800\u115F\u1160\u3164\uFFA0\u{1D159}]/u;

/**
 * The only forbidden code points a name may contain, and only where they
 * form part of an emoji sequence. They are removed before the check above;
 * anywhere else they stay and the name is rejected.
 * - the tags of the three RGI subdivision flags (England, Scotland,
 *   Wales): exactly the tag spelling of gbeng, gbsct or gbwls, then the
 *   cancel tag U+E007F, right after U+1F3F4 waving black flag. Any other
 *   tag run (other letters, after another emoji, unterminated) stays and
 *   rejects the name, so tags can never carry hidden text;
 * - a presentation selector U+FE0E or U+FE0F right after an emoji
 *   character (keycap bases 0-9, # and * included);
 * - a ZWJ U+200D between two emoji (after an emoji, a skin tone modifier
 *   or U+FE0F, before a pictographic emoji).
 */
const EMOJI_SEQUENCE_PARTS = new RegExp(
  [
    String.raw`(?<=\u{1F3F4})\u{E0067}\u{E0062}(?:\u{E0065}\u{E006E}\u{E0067}|\u{E0073}\u{E0063}\u{E0074}|\u{E0077}\u{E006C}\u{E0073})\u{E007F}`,
    String.raw`(?<=\p{Emoji})[\uFE0E\uFE0F]`,
    String.raw`(?<=[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F])\u200D(?=\p{Extended_Pictographic})`,
  ].join('|'),
  'gu',
);

/**
 * A visible character: a letter, number, symbol or punctuation. Every name
 * needs one, so names made only of spaces, combining marks, selectors or
 * joiners are rejected. The blank-looking characters in these categories
 * are forbidden above.
 */
const VISIBLE_CHARACTER = /[\p{L}\p{N}\p{S}\p{P}]/u;

/**
 * Validates and trims an optional display name (AC20). Returns the trimmed
 * name, or undefined when it is not acceptable: over the raw input cap,
 * empty after trimming, longer than 32 code points, containing a forbidden
 * code point outside an emoji sequence (including a lone surrogate), or
 * without any visible character. Server and client run this same function,
 * so both accept exactly the same names (given the same Unicode data; the
 * server is authoritative).
 */
export function normalizeDisplayName(raw: string): string | undefined {
  if (raw.length > MAX_DISPLAY_NAME_INPUT_LENGTH) return undefined;
  const trimmed = raw.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > MAX_DISPLAY_NAME_LENGTH) return undefined;
  if (FORBIDDEN_NAME_CHARACTER.test(trimmed.replace(EMOJI_SEQUENCE_PARTS, ''))) return undefined;
  if (!VISIBLE_CHARACTER.test(trimmed)) return undefined;
  return trimmed;
}
