import { ALPHA_CODE_ALPHABET, ALPHA_CODE_PATTERN, GROUP_CODE_PATTERN } from '@sync-system/protocol';
import { describe, expect, it } from 'vitest';
import { MAX_CODE_DRAWS } from '../src/limits/constants.js';
import { CodeIndex } from '../src/joins/code-index.js';
import {
  type GroupCodes,
  type RandomInt,
  drawAlphaCode,
  drawDoorCode,
  drawSixDigits,
  issueCodeSet,
  nextGeneration,
  rotateDoorCode,
} from '../src/joins/codes.js';

const NOW = 1_767_225_600_000;
const GID = 'G'.repeat(43);
const GID2 = 'H'.repeat(43);

/** A RandomInt that returns the given values in order, then repeats the last one. */
function sequence(...values: number[]): RandomInt {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

describe('code draws (AC7, AC8)', () => {
  it('draws 6-digit codes uniformly, with leading zeros', () => {
    const buckets = Array.from({ length: 10 }, () => 0);
    let leadingZero = 0;
    for (let i = 0; i < 10_000; i++) {
      const code = drawSixDigits();
      expect(code).toMatch(GROUP_CODE_PATTERN);
      buckets[Number(code[0])]! += 1;
      if (code.startsWith('0')) leadingZero += 1;
    }
    expect(leadingZero).toBeGreaterThan(0);
    // Loose bound on the first digit: about 1000 per bucket.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(800);
      expect(count).toBeLessThan(1200);
    }
    expect(drawSixDigits(() => 0)).toBe('000000');
    expect(drawSixDigits(() => 999_999)).toBe('999999');
  });

  it('draws alphanumeric codes from the 31-character alphabet only', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i++) {
      const code = drawAlphaCode();
      expect(code).toMatch(ALPHA_CODE_PATTERN);
      for (const char of code) seen.add(char);
    }
    expect([...seen].sort().join('')).toBe([...ALPHA_CODE_ALPHABET].sort().join(''));
  });

  it('never draws a door code equal to the group code or to the previous door code', () => {
    // First draw equals the group code, second equals the old door code, third is free.
    expect(drawDoorCode('000001', '000002', sequence(1, 2, 3))).toBe('000003');
    expect(drawDoorCode('000001', undefined, () => 1)).toBeUndefined();
  });
});

describe('nextGeneration (D4, R3)', () => {
  it('uses the millisecond clock as a floor and always increases', () => {
    expect(nextGeneration(0, NOW)).toBe(NOW);
    expect(nextGeneration(NOW + 5, NOW)).toBe(NOW + 6);
    let generation = nextGeneration(0, NOW);
    for (let i = 0; i < 50; i++) {
      const next = nextGeneration(generation, NOW);
      expect(next).toBeGreaterThan(generation);
      generation = next;
    }
    expect(generation).toBe(NOW + 50);
    // A restart one second later without a blob is above every earlier generation.
    expect(nextGeneration(0, NOW + 1000)).toBeGreaterThan(generation);
  });
});

describe('issueCodeSet (AC6-AC9, D12)', () => {
  it('issues exactly the codes of the methods and claims them', async () => {
    const index = new CodeIndex();
    const a = (await issueCodeSet(index, 'app-a', GID, ['A', 'D'], 0, NOW)) as GroupCodes;
    expect(a.groupCode).toMatch(GROUP_CODE_PATTERN);
    expect(a.doorCode).toMatch(GROUP_CODE_PATTERN);
    expect(a.doorCode).not.toBe(a.groupCode);
    expect(a.alphaCode).toBeUndefined();
    expect(await index.lookup('app-a', 'group', a.groupCode!)).toBe(GID);

    const b = (await issueCodeSet(index, 'app-a', GID2, ['B'], 0, NOW)) as GroupCodes;
    expect(b.groupCode).toMatch(GROUP_CODE_PATTERN);
    expect(b.doorCode).toBeUndefined();

    const c = (await issueCodeSet(index, 'app-b', GID, ['C', 'D'], 0, NOW)) as GroupCodes;
    expect(c.alphaCode).toMatch(ALPHA_CODE_PATTERN);
    expect(c.groupCode).toBeUndefined();
    expect(await index.lookup('app-b', 'alpha', c.alphaCode!)).toBe(GID);

    const d = (await issueCodeSet(index, 'app-b', GID2, ['D'], 0, NOW)) as GroupCodes;
    expect(d).toEqual({
      generation: NOW,
      ticketGeneration: NOW,
      groupCode: undefined,
      doorCode: undefined,
      alphaCode: undefined,
    });
  });

  it('sets the ticket generation to the new code generation (D12)', async () => {
    const index = new CodeIndex();
    const first = (await issueCodeSet(index, 'app-a', GID, ['A'], 0, NOW)) as GroupCodes;
    expect(first.ticketGeneration).toBe(first.generation);
    const second = (await issueCodeSet(
      index,
      'app-a',
      GID,
      ['A'],
      first.generation,
      NOW,
    )) as GroupCodes;
    expect(second.generation).toBe(NOW + 1);
    expect(second.ticketGeneration).toBe(second.generation);
  });

  it('redraws a taken code and keeps the same code free in another app (AC9)', async () => {
    const index = new CodeIndex();
    await index.claim('app-a', GID2, { groupCode: '000007' });
    const codes = (await issueCodeSet(
      index,
      'app-a',
      GID,
      ['B'],
      0,
      NOW,
      sequence(7, 8),
    )) as GroupCodes;
    expect(codes.groupCode).toBe('000008');
    const other = (await issueCodeSet(index, 'app-b', GID, ['B'], 0, NOW, () => 7)) as GroupCodes;
    expect(other.groupCode).toBe('000007');
  });

  it('treats the group own current codes as taken, so a new set replaces every code', async () => {
    const index = new CodeIndex();
    await index.claim('app-a', GID, { groupCode: '000007' });
    const codes = (await issueCodeSet(
      index,
      'app-a',
      GID,
      ['B'],
      0,
      NOW,
      sequence(7, 9),
    )) as GroupCodes;
    expect(codes.groupCode).toBe('000009');
  });

  it('gives up after MAX_CODE_DRAWS taken draws and claims nothing (CODES_EXHAUSTED)', async () => {
    const index = new CodeIndex();
    await index.claim('app-a', GID2, { groupCode: '000007', alphaCode: '22222222' });
    let draws = 0;
    const always7: RandomInt = () => {
      draws += 1;
      return 7;
    };
    expect(await issueCodeSet(index, 'app-a', GID, ['A'], 0, NOW, always7)).toBe('exhausted');
    expect(draws).toBe(MAX_CODE_DRAWS);
    expect(await issueCodeSet(index, 'app-a', GID, ['C'], 0, NOW, () => 0)).toBe('exhausted');
    // The group code drawn for a B+C set is not left claimed when C fails.
    expect(await issueCodeSet(index, 'app-a', GID, ['B', 'C'], 0, NOW, sequence(5, 0))).toBe(
      'exhausted',
    );
    expect(index.size).toBe(2);
  });
});

describe('rotateDoorCode (AC29, D12)', () => {
  it('replaces only the door code, bumps the code generation and keeps the ticket generation', async () => {
    const index = new CodeIndex();
    const codes = (await issueCodeSet(index, 'app-a', GID, ['A', 'C', 'D'], 0, NOW)) as GroupCodes;
    const rotated = rotateDoorCode(codes, NOW + 10) as GroupCodes;
    expect(rotated.groupCode).toBe(codes.groupCode);
    expect(rotated.alphaCode).toBe(codes.alphaCode);
    expect(rotated.doorCode).not.toBe(codes.doorCode);
    expect(rotated.doorCode).not.toBe(codes.groupCode);
    expect(rotated.generation).toBe(NOW + 10);
    expect(rotated.ticketGeneration).toBe(codes.ticketGeneration);
  });

  it('refuses a set without a door code', () => {
    expect(rotateDoorCode({ generation: 1, ticketGeneration: 1, groupCode: '000001' }, NOW)).toBe(
      'exhausted',
    );
  });

  it('keeps the invariants over any sequence of changes (D12)', async () => {
    const index = new CodeIndex();
    let codes = (await issueCodeSet(index, 'app-a', GID, ['A', 'D'], 0, NOW)) as GroupCodes;
    let previous = codes;
    let clock = NOW;
    for (let i = 0; i < 200; i++) {
      // Many changes within the same millisecond, then the clock moves.
      if (i % 7 === 0) clock += 1;
      const next =
        i % 3 === 0
          ? await issueCodeSet(index, 'app-a', GID, ['A', 'D'], codes.generation, clock)
          : rotateDoorCode(codes, clock);
      expect(next).not.toBe('exhausted');
      codes = next as GroupCodes;
      expect(codes.ticketGeneration).toBeLessThanOrEqual(codes.generation);
      expect(codes.generation).toBeGreaterThan(previous.generation);
      expect(codes.ticketGeneration).toBeGreaterThanOrEqual(previous.ticketGeneration);
      if (codes.ticketGeneration !== previous.ticketGeneration) {
        expect(codes.ticketGeneration).toBe(codes.generation);
      }
      previous = codes;
    }
  });
});
