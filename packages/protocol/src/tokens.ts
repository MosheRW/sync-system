import { z } from 'zod';
import { buildJitless } from './jitless.js';
import { checkJson } from './json-guard.js';
import {
  GROUP_ID_PATTERN,
  MAX_TOKEN_LENGTH,
  NAMESPACE_PATTERN,
  PARTICIPANT_ID_PATTERN,
} from './limits.js';
import type { Role } from './messages.js';

/** Version of the token claim set. Additive claims keep it at 1 (#5 AC40). */
export const TOKEN_FORMAT_VERSION = 1;

/**
 * Claims of a participant token (architecture 4.1). The payload is readable
 * by whoever holds the token; it holds no personal data and nothing secret.
 */
export interface TokenClaims {
  /** Token format version. */
  readonly v: typeof TOKEN_FORMAT_VERSION;
  /** App namespace (audience). */
  readonly aud: string;
  /** Group ID. */
  readonly gid: string;
  /** Group-scoped participant ID. */
  readonly pid: string;
  readonly role: Role;
  /** Group creation time, epoch ms. */
  readonly gct: number;
  /** The leader's last activity when the token was issued, epoch ms. */
  readonly lat: number;
  /** Issued at, epoch seconds. */
  readonly iat: number;
  /** Expiry, epoch seconds. */
  readonly exp: number;
}

/** Each of the three JWT segments: base64url without padding. */
export const TOKEN_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Deepest claims object accepted (the claims are flat; this leaves slack). */
const MAX_CLAIMS_DEPTH = 4;

const timestamp = () => z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/**
 * Claims schema. Unknown extra claims are stripped (they are ignored, never
 * carried forward when a token is re-signed). `lat >= gct` and `exp > iat`
 * hold for every token the server issues.
 */
export const tokenClaimsSchema = buildJitless(() =>
  z
    .object({
      v: z.literal(TOKEN_FORMAT_VERSION),
      aud: z.string().regex(NAMESPACE_PATTERN),
      gid: z.string().regex(GROUP_ID_PATTERN),
      pid: z.string().regex(PARTICIPANT_ID_PATTERN),
      role: z.enum(['leader', 'member']),
      gct: timestamp(),
      lat: timestamp(),
      iat: timestamp(),
      exp: timestamp(),
    })
    .strip()
    .refine((claims) => claims.lat >= claims.gct && claims.exp > claims.iat),
);

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Decodes one base64url segment to a string of ASCII characters, without any
 * host global (`atob`, `Buffer`). Returns undefined for a character outside
 * the alphabet, an impossible length, or a decoded byte above 0x7f: token
 * payloads are ASCII-only JSON.
 */
export function base64UrlToAscii(segment: string): string | undefined {
  if (!TOKEN_SEGMENT_PATTERN.test(segment) || segment.length % 4 === 1) return undefined;
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < segment.length; i++) {
    const value = BASE64URL_ALPHABET.indexOf(segment[i]!);
    if (value < 0) return undefined;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const byte = (buffer >> bits) & 0xff;
      if (byte > 0x7f) return undefined;
      out += String.fromCharCode(byte);
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
}

/** The three segments of a well-formed token, or undefined. Length is checked first. */
export function splitToken(token: unknown): [string, string, string] | undefined {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  for (const part of parts) {
    if (!TOKEN_SEGMENT_PATTERN.test(part)) return undefined;
  }
  return parts as [string, string, string];
}

/** Parses a payload segment into claims, or undefined. Never throws. */
export function parseClaimsSegment(payloadSegment: string): TokenClaims | undefined {
  const text = base64UrlToAscii(payloadSegment);
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (checkJson(value, { maxDepth: MAX_CLAIMS_DEPTH }) !== 'ok') return undefined;
  const result = tokenClaimsSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

/**
 * Reads a token's claims **without verifying** its signature. The client uses
 * this to know which group and role a stored token is for; the server calls
 * it only after the signature check passed.
 */
export function decodeTokenClaims(token: unknown): TokenClaims | undefined {
  const parts = splitToken(token);
  return parts === undefined ? undefined : parseClaimsSegment(parts[1]);
}
