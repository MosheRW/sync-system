import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  type CanonicalJsonValue,
  canonicalJson,
} from '../src/content/canonical-json.js';

/** A literal JSON escape `\uXXXX` built at runtime (keeps the source ASCII-plain). */
const u = (hex: string) => `\\u${hex}`;

describe('canonicalJson (RFC 8785)', () => {
  it('drops whitespace and sorts keys recursively', () => {
    const value = JSON.parse(
      '{ "b": [ 1, { "z": true, "a": null } ], "a": "x" }',
    ) as CanonicalJsonValue;
    expect(canonicalJson(value)).toBe('{"a":"x","b":[1,{"a":null,"z":true}]}');
  });

  it('matches the RFC 8785 section 3.2.2 sample', () => {
    const input =
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
      `"string":"${u('20ac')}$${u('000F')}${u('000a')}A'${u('0042')}${u('0022')}${u('005c')}\\\\\\"\\/",` +
      '"literals":[null,true,false]}';
    const expected =
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
      `"string":"\u{20AC}$${u('000f')}\\nA'B\\"\\\\\\\\\\"/"}`;
    expect(canonicalJson(JSON.parse(input) as CanonicalJsonValue)).toBe(expected);
  });

  it('sorts keys by UTF-16 code units (RFC 8785 section 3.2.3)', () => {
    const keys = ['\u{20AC}', '\r', '\u{FB33}', '1', '\u{1F600}', '\u{80}', '\u{F6}'];
    const value: Record<string, CanonicalJsonValue> = {};
    keys.forEach((key, i) => (value[key] = i));
    const text = canonicalJson(value);
    const positions = ['\r', '1', '\u{80}', '\u{F6}', '\u{20AC}', '\u{1F600}', '\u{FB33}'].map(
      (key) => text.indexOf(JSON.stringify(key)),
    );
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('serialises strings like JSON.stringify (control characters, quotes, non-ASCII)', () => {
    expect(canonicalJson('a"b\\c\n\t\u{1}é')).toBe(JSON.stringify('a"b\\c\n\t\u{1}é'));
    expect(canonicalJson('/')).toBe('"/"');
  });

  it('reads only own keys', () => {
    const value = Object.create({ inherited: 1 }) as Record<string, CanonicalJsonValue>;
    value['own'] = 2;
    expect(canonicalJson(value)).toBe('{"own":2}');
  });

  it('refuses values JSON cannot hold', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: undefined } as unknown as CanonicalJsonValue)).toThrow(
      CanonicalJsonError,
    );
    let deep: CanonicalJsonValue = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(CanonicalJsonError);
  });
});
