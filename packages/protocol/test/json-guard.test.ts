import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH, checkJson } from '../src/index.js';

const opts = { maxDepth: MAX_JSON_DEPTH };

function nestedArrays(depth: number): string {
  return '['.repeat(depth) + ']'.repeat(depth);
}

function nestedObjects(depth: number): string {
  let text = '1';
  for (let i = 0; i < depth; i++) text = `{"a":${text}}`;
  return text;
}

describe('checkJson', () => {
  it('accepts every JSON value type', () => {
    for (const value of [null, true, false, 0, -1.5, '', 'text', [], {}, [1, 'a', null, {}]]) {
      expect(checkJson(value, opts)).toBe('ok');
    }
    expect(checkJson(JSON.parse('{"a":[{"b":"c"}],"d":null}'), opts)).toBe('ok');
  });

  it('accepts depth 64 and rejects depth 65', () => {
    expect(checkJson(JSON.parse(nestedArrays(64)), opts)).toBe('ok');
    expect(checkJson(JSON.parse(nestedArrays(65)), opts)).toBe('too_deep');
    expect(checkJson(JSON.parse(nestedObjects(64)), opts)).toBe('ok');
    expect(checkJson(JSON.parse(nestedObjects(65)), opts)).toBe('too_deep');
  });

  it('counts containers, not primitives, toward depth', () => {
    expect(checkJson('x', { maxDepth: 0 })).toBe('ok');
    expect(checkJson({}, { maxDepth: 0 })).toBe('too_deep');
    expect(checkJson({ a: { b: 1 } }, { maxDepth: 2 })).toBe('ok');
    expect(checkJson({ a: { b: {} } }, { maxDepth: 2 })).toBe('too_deep');
  });

  it('returns too_deep for depth 10,000 without throwing (M4)', () => {
    const deepArrays: unknown = JSON.parse(nestedArrays(10_000));
    const deepObjects: unknown = JSON.parse(nestedObjects(10_000));
    expect(() => checkJson(deepArrays, opts)).not.toThrow();
    expect(checkJson(deepArrays, opts)).toBe('too_deep');
    expect(checkJson(deepObjects, opts)).toBe('too_deep');
  });

  it('walks a very deep value iteratively when the limit allows it', () => {
    const deep: unknown = JSON.parse(nestedArrays(50_000));
    expect(checkJson(deep, { maxDepth: 100_000 })).toBe('ok');
  });

  it('rejects values JSON cannot represent', () => {
    for (const value of [
      undefined,
      () => 1,
      Symbol('s'),
      1n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(),
      new Map(),
      { nested: [undefined] },
    ]) {
      expect(checkJson(value, opts)).toBe('invalid');
    }
  });

  it('keeps __proto__ keys and does not copy the value (L6)', () => {
    const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1}}') as Record<
      string,
      unknown
    >;
    const before = JSON.stringify(value);
    expect(checkJson(value, opts)).toBe('ok');
    expect(JSON.stringify(value)).toBe(before);
    expect(Object.keys(value)).toEqual(['__proto__', 'constructor']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('checks the value under an own __proto__ key', () => {
    const value: unknown = JSON.parse(`{"__proto__":${nestedArrays(70)}}`);
    expect(checkJson(value, opts)).toBe('too_deep');
  });
});
