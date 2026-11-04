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
    const refs = [...(ended as unknown as { plain: Map<string, unknown> }).plain.keys()];
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

describe('EndedGroups guard, cap order and recovery closure (#13 6.9, RC17, RC20)', () => {
  it('evicts plain entries first, then guarded ones whose guard has passed', () => {
    const { ended, advance } = make(2);
    ended.remember('app-a', 'guarded', 99_000, 5_000);
    ended.remember('app-a', 'plain', 99_000);
    ended.remember('app-a', 'third', 99_000);
    // The plain entry went; the guarded one stays.
    expect(ended.has('app-a', 'plain')).toBe(false);
    expect(ended.has('app-a', 'guarded')).toBe(true);
    expect(ended.isRecoveryClosed('app-a')).toBe(false);
    // Past its guard, a guarded entry is evicted like a plain one, without
    // closing recovery (plain entries still go first).
    advance(4_000);
    ended.remember('app-a', 'fourth', 99_000, 50_000);
    expect(ended.has('app-a', 'third')).toBe(false);
    ended.remember('app-a', 'fifth', 99_000, 50_000);
    expect(ended.has('app-a', 'guarded')).toBe(false);
    expect(ended.has('app-a', 'fourth')).toBe(true);
    expect(ended.isRecoveryClosed('app-a')).toBe(false);
  });

  it('a guard already passed when remembered makes a plain entry', () => {
    const { ended } = make(1);
    ended.remember('app-a', 'a', 99_000, 500);
    ended.remember('app-a', 'b', 99_000);
    expect(ended.has('app-a', 'a')).toBe(false);
    expect(ended.isRecoveryClosed('app-a')).toBe(false);
  });

  it('with only live guarded entries, evicts one and closes recovery until its guard', () => {
    const { ended, warnings, advance } = make(2);
    ended.remember('app-a', 'a', 99_000, 6_000);
    ended.remember('app-a', 'b', 99_000, 9_000);
    ended.remember('app-a', 'c', 99_000, 9_000);
    expect(ended.has('app-a', 'a')).toBe(false);
    expect(ended.isRecoveryClosed('app-a')).toBe(true);
    expect(ended.isRecoveryClosed('app-b')).toBe(false);
    expect(warnings).toContainEqual({ event: 'ended_groups_recovery_closed', namespace: 'app-a' });
    // One closure warning per minute per namespace.
    ended.remember('app-a', 'd', 99_000, 9_000);
    expect(
      warnings.filter((w) => (w as { event: string }).event === 'ended_groups_recovery_closed'),
    ).toHaveLength(1);
    // Closed until the latest evicted guard (b's, 9_000), then open again.
    advance(7_999);
    expect(ended.isRecoveryClosed('app-a')).toBe(true);
    advance(1);
    expect(ended.isRecoveryClosed('app-a')).toBe(false);
  });

  it('closes the namespace with the most guarded entries, not the one with the oldest (M5)', () => {
    const { ended } = make(3);
    ended.remember('honest', 'h1', 99_000, 9_000);
    ended.remember('flood', 'f1', 99_000, 9_000);
    ended.remember('flood', 'f2', 99_000, 9_000);
    ended.remember('flood', 'f3', 99_000, 9_000);
    expect(ended.isRecoveryClosed('flood')).toBe(true);
    expect(ended.isRecoveryClosed('honest')).toBe(false);
    expect(ended.has('honest', 'h1')).toBe(true);
    expect(ended.has('flood', 'f1')).toBe(false);
  });

  it('sweeps passed closures and expired guarded entries', () => {
    const { ended, advance } = make(1);
    ended.remember('app-a', 'a', 3_000, 2_000);
    ended.remember('app-a', 'b', 3_000, 2_000);
    expect(ended.isRecoveryClosed('app-a')).toBe(true);
    advance(2_500);
    ended.sweep();
    expect(ended.isRecoveryClosed('app-a')).toBe(false);
    expect(ended.size).toBe(0);
  });
});
