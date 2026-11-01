/**
 * Size of a JSON value as the server would relay it: UTF-8 bytes of its
 * re-serialization (whitespace in the client's frame does not count). Only
 * call this after checkJson passed, so JSON.stringify cannot overflow.
 */
export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
