import { jsonByteLength as serverJsonByteLength } from '@sync-system/server/src/limits/json-size.js';
import { describe, expect, it } from 'vitest';
import { jsonByteLength } from '../src/json-size.js';

describe('jsonByteLength (AC22)', () => {
  it.each([
    ['ascii', { page: 12, chapter: 'one' }],
    ['multi-byte', { title: 'קריאה בקבוצה', accents: 'éàü' }],
    ['emoji', ['📖', '👩‍👩‍👧', { e: '🎉' }]],
    ['lone surrogates', { a: '\ud800', b: 'x\udfffy' }],
    ['control characters', String.fromCharCode(0, 31, 10, 34, 92)],
    ['numbers and null', [0, -1.5, 1e21, null, true]],
    ['__proto__ key', JSON.parse('{"__proto__":{"x":1}}') as unknown],
  ])('matches the server measure for %s', (_name, value) => {
    expect(jsonByteLength(value)).toBe(serverJsonByteLength(value));
  });

  it('counts bytes, not characters', () => {
    expect(jsonByteLength('é')).toBe(4);
    expect(jsonByteLength('ab')).toBe(4);
  });
});
