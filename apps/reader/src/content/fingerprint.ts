import { type CanonicalJsonValue, canonicalJson } from './canonical-json.js';

/** The part of `SubtleCrypto` the fingerprint needs (injectable for tests). */
export interface DigestProvider {
  digest(algorithm: 'SHA-256', data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
}

/** Web Crypto is missing: the page is not a secure context (HTTP on a non-localhost host). */
export class CryptoUnavailableError extends Error {
  override readonly name = 'CryptoUnavailableError';
  readonly kind = 'crypto-unavailable';
}

/** A fingerprint: 64 lowercase hex characters. */
export const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

function defaultSubtle(): DigestProvider | undefined {
  return (globalThis.crypto as Crypto | undefined)?.subtle;
}

/**
 * SHA-256 over the UTF-8 bytes of the RFC 8785 canonical JSON of a
 * *validated* content document, as lowercase hex (ADR 0004 D1, AC6). Always
 * computed by the app, never read from the file. Not a signature: a matching
 * fingerprint proves sameness, not authenticity (security F8).
 */
export async function computeFingerprint(
  value: CanonicalJsonValue,
  subtle?: DigestProvider | null,
): Promise<string> {
  // `null` means "no Web Crypto" (tests); `undefined` means "use the global".
  const provider = subtle === undefined ? defaultSubtle() : subtle;
  if (!provider) throw new CryptoUnavailableError('Web Crypto is not available');
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await provider.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
