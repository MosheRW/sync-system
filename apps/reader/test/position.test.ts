import { describe, expect, it } from 'vitest';
import { decodePosition, encodePosition } from '../src/group/position.js';

describe('position payload v1 (#24 AC29, architecture 6)', () => {
  it('encodes exactly { v: 1, pageIndex }', () => {
    expect(encodePosition(3)).toEqual({ v: 1, pageIndex: 3 });
    expect(Object.keys(encodePosition(0))).toEqual(['v', 'pageIndex']);
    expect(JSON.stringify(encodePosition(12))).toBe('{"v":1,"pageIndex":12}');
  });

  it('decodes a valid position inside the book', () => {
    expect(decodePosition({ v: 1, pageIndex: 0 }, 5)).toBe(0);
    expect(decodePosition({ pageIndex: 4, v: 1 }, 5)).toBe(4);
    expect(decodePosition(JSON.parse('{"v":1,"pageIndex":2}'), 3)).toBe(2);
  });

  const proto = Object.create({ v: 1 }) as Record<string, unknown>;
  proto['pageIndex'] = 1;
  const nullProto = Object.assign(Object.create(null) as object, { v: 1, pageIndex: 1 });
  class Position {
    v = 1;
    pageIndex = 1;
  }

  it.each<[string, unknown]>([
    ['a wrong version', { v: 2, pageIndex: 1 }],
    ['a string version', { v: '1', pageIndex: 1 }],
    ['an extra key', { v: 1, pageIndex: 1, preview: true }],
    ['a missing page', { v: 1 }],
    ['a negative page', { v: 1, pageIndex: -1 }],
    ['a fractional page', { v: 1, pageIndex: 1.5 }],
    ['a page past the end', { v: 1, pageIndex: 5 }],
    ['a huge page', { v: 1, pageIndex: Number.MAX_SAFE_INTEGER + 2 }],
    ['NaN', { v: 1, pageIndex: Number.NaN }],
    ['a string page', { v: 1, pageIndex: '1' }],
    ['an array', [1, 1]],
    ['a number', 3],
    ['null', null],
    ['undefined', undefined],
    ['an inherited version', proto],
    ['a null-prototype object', nullProto],
    ['a class instance', new Position()],
    ['__proto__ from JSON', JSON.parse('{"__proto__":{"v":1},"pageIndex":1}')],
  ])('ignores %s', (_name, value) => {
    expect(decodePosition(value, 5)).toBeNull();
  });
});
