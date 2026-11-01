import { textEncoder } from './host.js';

/**
 * UTF-8 bytes of `JSON.stringify(value)`: the same measure as the server's
 * `Buffer.byteLength(JSON.stringify(value), 'utf8')` (AC22). `JSON.stringify`
 * escapes lone surrogates, so both sides see the same well-formed string.
 * Only call this after `checkJson` passed (no cycles, no BigInt).
 */
export function jsonByteLength(value: unknown): number {
  return textEncoder().encode(JSON.stringify(value)).length;
}
