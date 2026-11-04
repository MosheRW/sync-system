import { timingSafeEqual } from 'node:crypto';
import { base64UrlToAscii } from '@sync-system/protocol';
import { SIGNATURE_SEGMENT_LENGTH, hmacSha256 } from './jwt.js';

/**
 * The compact signed format of QR tickets and codes blobs (#10 D2):
 * `base64url(payloadJson) "." base64url(hmacSha256(payloadSegment, key))`.
 * Two segments (a token has three, with a fixed header), so the shapes are
 * disjoint, and each purpose has its own per-app key.
 */
const COMPACT_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

/** Signs an already serialized, ASCII-only JSON payload. */
export function signCompact(payloadJson: string, key: Buffer): string {
  const payloadSegment = Buffer.from(payloadJson, 'utf8').toString('base64url');
  return `${payloadSegment}.${hmacSha256(payloadSegment, key).toString('base64url')}`;
}

export interface VerifiedCompact {
  /** The decoded payload text (ASCII), not yet parsed. */
  payloadJson: string;
  /** Index into `keys` of the key that matched (0 = current). */
  keyIndex: number;
}

/**
 * Checks a compact signed string (#10 R5): length cap first, then the exact
 * two-segment base64url shape with a 43-character signature (before any
 * decoding), then a constant-time comparison against **every** key, so the
 * time taken does not depend on which key matched. Only then is the payload
 * decoded (ASCII only). Never parses JSON and never throws: any failure is
 * undefined, and nothing of the input is returned.
 */
export function verifyCompact(
  text: unknown,
  keys: readonly Buffer[],
  maxLength: number,
): VerifiedCompact | undefined {
  if (typeof text !== 'string' || text.length > maxLength) return undefined;
  if (!COMPACT_PATTERN.test(text)) return undefined;
  const dot = text.indexOf('.');
  const payloadSegment = text.slice(0, dot);
  const signature = text.slice(dot + 1);
  if (signature.length !== SIGNATURE_SEGMENT_LENGTH) return undefined;

  const presented = Buffer.from(signature, 'ascii');
  let keyIndex = -1;
  keys.forEach((key, index) => {
    const expected = Buffer.from(hmacSha256(payloadSegment, key).toString('base64url'), 'ascii');
    if (timingSafeEqual(expected, presented) && keyIndex === -1) keyIndex = index;
  });
  if (keyIndex === -1) return undefined;
  const payloadJson = base64UrlToAscii(payloadSegment);
  if (payloadJson === undefined) return undefined;
  return { payloadJson, keyIndex };
}

/** Parses JSON into a plain object, or undefined. Never throws. */
export function parseCompactPayload(payloadJson: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(payloadJson);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** A safe, non-negative integer claim. */
export function isClaimInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** True when `claims` has exactly `keys` and nothing else. */
export function hasExactKeys(claims: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(claims);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(claims, key));
}
