import { describe, expect, it } from 'vitest';
import { jsonByteLength } from '../src/limits/json-size.js';

describe('jsonByteLength (AC27)', () => {
  it('measures the re-serialized JSON', () => {
    expect(jsonByteLength(null)).toBe(4);
    expect(jsonByteLength('ab')).toBe(4);
    expect(jsonByteLength({ a: 1 })).toBe(7);
    expect(jsonByteLength(JSON.parse('{ "a" :   [ 1 , 2 ] }'))).toBe('{"a":[1,2]}'.length);
  });

  it('counts UTF-8 bytes, not characters', () => {
    expect(jsonByteLength('א')).toBe(4); // 2 quote bytes + 2 bytes
    expect(jsonByteLength('📖')).toBe(6); // 4-byte code point
    expect(jsonByteLength('€')).toBe(5);
  });

  it('counts escapes as serialized', () => {
    expect(jsonByteLength('"')).toBe(4); // "\""
    expect(jsonByteLength('\n')).toBe(4); // "\n"
  });
});
