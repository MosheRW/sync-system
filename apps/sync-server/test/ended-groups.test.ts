import { describe, expect, it } from 'vitest';
import { EndedGroups } from '../src/groups/ended-groups.js';

function make(cap?: number) {
  let time = 1_000;
  const warnings: object[] = [];
  const ended = new EndedGroups(() => time, { warn: (obj) => warnings.push(obj) }, cap);
  return {
    ended,
    warnings,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('EndedGroups (Q8, L4)', () => {
  it('remembers a group until its deadline, per namespace', () => {
    const { ended, advance } = make();
    ended.remember('app-a', 'g1', 2_000);
    expect(ended.has('app-a', 'g1')).toBe(true);
    expect(ended.has('app-b', 'g1')).toBe(false);
    expect(ended.has('app-a', 'g2')).toBe(false);
    advance(999);
    expect(ended.has('app-a', 'g1')).toBe(true);
    advance(1);
    expect(ended.has('app-a', 'g1')).toBe(false);
    expect(ended.size).toBe(0);
  });

  it('ignores a deadline that has already passed', () => {
    const { ended } = make();
    ended.remember('app-a', 'g1', 1_000);
    expect(ended.size).toBe(0);
  });

  it('sweeps expired refs', () => {
    const { ended, advance } = make();
    ended.remember('app-a', 'short', 1_500);
    ended.remember('app-a', 'long', 5_000);
    advance(600);
    ended.sweep();
    expect(ended.size).toBe(1);
    expect(ended.has('app-a', 'long')).toBe(true);
  });

  it('stores hashed refs only, never the raw group ID', () => {
    const { ended } = make();
    const groupId = 'RAW-GROUP-ID-SENTINEL'.padEnd(43, 'x');
    ended.remember('app-a', groupId, 9_000);
    const refs = [...(ended as unknown as { refs: Map<string, number> }).refs.keys()];
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(refs[0]).not.toContain('SENTINEL');
  });

  it('evicts the oldest at the cap and warns with a count at most once a minute', () => {
    const { ended, warnings, advance } = make(3);
    for (const id of ['a', 'b', 'c', 'd']) ended.remember('app-a', id, 99_000);
    expect(ended.size).toBe(3);
    expect(ended.has('app-a', 'a')).toBe(false);
    expect(ended.has('app-a', 'd')).toBe(true);
    expect(warnings).toEqual([{ event: 'ended_groups_evicting', count: 1 }]);
    ended.remember('app-a', 'e', 99_000);
    expect(warnings).toHaveLength(1);
    advance(60_000);
    ended.remember('app-a', 'f', 99_000);
    expect(warnings).toEqual([
      { event: 'ended_groups_evicting', count: 1 },
      { event: 'ended_groups_evicting', count: 2 },
    ]);
  });
});
