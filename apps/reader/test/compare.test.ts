import { describe, expect, it } from 'vitest';
import { compareContent } from '../src/content/compare.js';
import type { ContentMetadata } from '../src/content/metadata.js';

const fp = (c: string) => c.repeat(64);
const local: ContentMetadata = {
  contentId: 'acme/psalms-he',
  fingerprint: fp('a'),
  schemaVersion: 1,
};

describe('compareContent (AC15-AC17)', () => {
  it('match', () => {
    expect(compareContent(local, { ...local })).toEqual({ result: 'match', outcome: 'none' });
  });

  it('different-version warns', () => {
    expect(compareContent(local, { ...local, fingerprint: fp('b') })).toEqual({
      result: 'different-version',
      outcome: 'warn',
    });
  });

  it('different-content blocks (Gate 2 Q3)', () => {
    expect(compareContent(local, { ...local, contentId: 'acme/other' })).toEqual({
      result: 'different-content',
      outcome: 'block',
    });
    expect(
      compareContent(local, { ...local, contentId: 'acme/other', fingerprint: fp('b') }),
    ).toEqual({ result: 'different-content', outcome: 'block' });
  });

  it('unsupported-schema blocks, even with the same fingerprint (AC16, AC17)', () => {
    expect(compareContent(local, { ...local, schemaVersion: 2 })).toEqual({
      result: 'unsupported-schema',
      outcome: 'block',
    });
    expect(compareContent(local, { ...local, fingerprint: fp('b'), schemaVersion: 2 })).toEqual({
      result: 'unsupported-schema',
      outcome: 'block',
    });
    expect(compareContent(local, { ...local }, { min: 2, max: 3 })).toEqual({
      result: 'unsupported-schema',
      outcome: 'block',
    });
  });

  it.each([
    ['null', null],
    ['a string', 'acme/psalms-he'],
    ['an array', [local]],
    ['missing fingerprint', { contentId: local.contentId, schemaVersion: 1 }],
    ['bad content ID', { ...local, contentId: 'ACME/x' }],
    ['short fingerprint', { ...local, fingerprint: 'abc' }],
    ['uppercase fingerprint', { ...local, fingerprint: fp('A') }],
    ['version as string', { ...local, schemaVersion: '1' }],
    ['version 0', { ...local, schemaVersion: 0 }],
    ['version 1.5', { ...local, schemaVersion: 1.5 }],
    ['extra key', { ...local, extra: true }],
    ['inherited keys', Object.create(local) as unknown],
  ])('malformed leader metadata (%s) is unsupported-schema/block (Gate 2 Q4)', (_name, leader) => {
    expect(compareContent(local, leader)).toEqual({
      result: 'unsupported-schema',
      outcome: 'block',
    });
  });

  it('treats an own __proto__ key as malformed (C4)', () => {
    const leader = JSON.parse(
      `{"contentId":"acme/psalms-he","fingerprint":"${fp('a')}","schemaVersion":1,"__proto__":{"x":1}}`,
    ) as unknown;
    expect(compareContent(local, leader).result).toBe('unsupported-schema');
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });
});
