import { describe, expect, it } from 'vitest';
import { CodeIndex } from '../src/joins/code-index.js';

const G1 = 'A'.repeat(43);
const G2 = 'B'.repeat(43);

describe('CodeIndex (AC9, AC11, AC13, R14)', () => {
  it('looks codes up per app and per kind', () => {
    const index = new CodeIndex();
    expect(index.claim('app-a', G1, { groupCode: '123456', alphaCode: 'ABCDEFGH' })).toBe(true);
    expect(index.lookup('app-a', 'group', '123456')).toBe(G1);
    expect(index.lookup('app-a', 'alpha', 'ABCDEFGH')).toBe(G1);
    expect(index.lookup('app-a', 'alpha', '123456')).toBeUndefined();
    expect(index.lookup('app-b', 'group', '123456')).toBeUndefined();
    expect(index.isFree('app-a', 'group', '123456')).toBe(false);
    expect(index.isFree('app-b', 'group', '123456')).toBe(true);
    expect(index.size).toBe(2);
  });

  it('allows the same code in two apps at once', () => {
    const index = new CodeIndex();
    expect(index.claim('app-a', G1, { groupCode: '123456' })).toBe(true);
    expect(index.claim('app-b', G2, { groupCode: '123456' })).toBe(true);
    expect(index.lookup('app-a', 'group', '123456')).toBe(G1);
    expect(index.lookup('app-b', 'group', '123456')).toBe(G2);
  });

  it('claims all codes or none', () => {
    const index = new CodeIndex();
    index.claim('app-a', G1, { alphaCode: 'ABCDEFGH' });
    expect(index.claim('app-a', G2, { groupCode: '123456', alphaCode: 'ABCDEFGH' })).toBe(false);
    expect(index.lookup('app-a', 'group', '123456')).toBeUndefined();
    expect(index.size).toBe(1);
    // A code the group itself holds is free for it.
    expect(index.claim('app-a', G1, { groupCode: '123456', alphaCode: 'ABCDEFGH' })).toBe(true);
    expect(index.size).toBe(2);
  });

  it('releases only codes the group still holds', () => {
    const index = new CodeIndex();
    index.claim('app-a', G1, { groupCode: '123456' });
    index.release('app-a', G2, { groupCode: '123456' });
    expect(index.lookup('app-a', 'group', '123456')).toBe(G1);
    index.release('app-a', G1, { groupCode: '123456', alphaCode: 'ZZZZZZZZ' });
    expect(index.lookup('app-a', 'group', '123456')).toBeUndefined();
    expect(index.size).toBe(0);
    index.release('app-x', G1, { groupCode: '1' });
  });

  it('clears everything', () => {
    const index = new CodeIndex();
    index.claim('app-a', G1, { groupCode: '123456' });
    index.claim('app-b', G1, { alphaCode: 'ABCDEFGH' });
    index.clear();
    expect(index.size).toBe(0);
  });
});
