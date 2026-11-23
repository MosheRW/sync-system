import { createHmac, timingSafeEqual } from 'node:crypto';
import { splitToken } from '@mosherw/sync-system-protocol';

/**
 * The only header this server emits or accepts: `{"alg":"HS256","typ":"JWT"}`.
 * A token's header segment must be byte-equal to it, so `alg: none`, other
 * algorithms, `kid`, `jku`, `crit` and reordered keys are all rejected before
 * any HMAC is computed (architecture 1.1, R1).
 */
export const TOKEN_HEADER_SEGMENT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';

/** base64url length of a 32-byte HMAC-SHA256 without padding. */
export const SIGNATURE_SEGMENT_LENGTH = 43;

/** HMAC-SHA256 of `signingInput` (ASCII) with `key`. */
export function hmacSha256(signingInput: string, key: Buffer): Buffer {
  return createHmac('sha256', key).update(signingInput, 'ascii').digest();
}

/** `header.payload.signature` for an already serialized, ASCII-only payload. */
export function signHs256(payloadJson: string, key: Buffer): string {
  const signingInput = `${TOKEN_HEADER_SEGMENT}.${Buffer.from(payloadJson, 'utf8').toString('base64url')}`;
  return `${signingInput}.${hmacSha256(signingInput, key).toString('base64url')}`;
}

export interface VerifiedSegments {
  payloadSegment: string;
  /** Index into `keys` of the key that matched (0 = current). */
  keyIndex: number;
}

/**
 * Checks the shape and signature of `token` against each key, in order:
 * length cap and charset (before decoding), exactly three segments, the fixed
 * header, a canonical 43-character signature (L1), then a constant-time
 * comparison of the expected and presented signature text for every key.
 * Never parses the payload. Returns undefined on any failure.
 */
export function verifyHs256(token: unknown, keys: readonly Buffer[]): VerifiedSegments | undefined {
  const parts = splitToken(token);
  if (parts === undefined) return undefined;
  const [header, payloadSegment, signature] = parts;
  if (header !== TOKEN_HEADER_SEGMENT) return undefined;
  if (signature.length !== SIGNATURE_SEGMENT_LENGTH) return undefined;

  const presented = Buffer.from(signature, 'ascii');
  const signingInput = `${header}.${payloadSegment}`;
  let keyIndex = -1;
  // Every key is checked, so the time taken does not depend on which matched.
  keys.forEach((key, index) => {
    const expected = Buffer.from(hmacSha256(signingInput, key).toString('base64url'), 'ascii');
    if (timingSafeEqual(expected, presented) && keyIndex === -1) keyIndex = index;
  });
  return keyIndex === -1 ? undefined : { payloadSegment, keyIndex };
}
