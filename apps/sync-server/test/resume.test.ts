import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/apps/app-registry.js';
import type { GroupRecord } from '../src/groups/group-store.js';
import { canSupersede, classifyToken } from '../src/groups/resume.js';
import { nextTerm } from '../src/lifecycle/succession.js';
import { claimsAt } from './helpers/tokens.js';

const MINUTE = 60_000;
const NOW = 1_767_225_600_000;
const SLACK = 300_000;
const APP = { maxSessionMinutes: 180, inactivityLimitMinutes: 20 } as AppConfig;
const WINDOW = 20 * MINUTE + SLACK;

function record(overrides: Partial<GroupRecord> = {}): GroupRecord {
  return { leaderId: 'L', blockList: [], ...overrides } as GroupRecord;
}

function classify(claims: Record<string, unknown>, rec: GroupRecord | undefined, now = NOW) {
  return classifyToken({
    claims: claimsAt(NOW - 10 * MINUTE, claims) as never,
    app: APP,
    record: rec,
    ended: false,
    epoch: NOW - 60 * MINUTE,
    recoveryClosed: false,
    now,
    refreshMaxMs: SLACK,
  });
}

describe('classifyToken with a live record (#13 D4, RC8, L2)', () => {
  const old = { iat: Math.floor((NOW - 90 * MINUTE) / 1000) };

  it('takes the role from the record, not the token', () => {
    expect(classify({ ...old, pid: 'L', role: 'member' }, record())).toBe('live');
    expect(classify({ ...old, pid: 'X', role: 'leader' }, record())).toBe('live');
  });

  it('applies the lat bound only when the token would act as leader', () => {
    const later = NOW - 10 * MINUTE + WINDOW;
    expect(classify({ ...old, pid: 'L', role: 'member' }, record(), later)).toBe('expired');
    expect(classify({ ...old, pid: 'X', role: 'leader' }, record(), later)).toBe('live');
    expect(classify({ ...old, pid: 'L', role: 'leader' }, undefined, later)).toBe('expired');
    expect(classify({ ...old, pid: 'M', role: 'member' }, undefined, later)).toBe('waiting');
  });

  it('blocks every role on the block list', () => {
    for (const role of ['leader', 'member']) {
      expect(classify({ ...old, pid: 'X', role }, record({ blockList: ['X'] }))).toBe('blocked');
    }
  });
});

describe('canSupersede truth table (#13 12.1)', () => {
  const base = { recoveredAt: 1_000, anchorTerm: 400, leaderId: 'A' };
  const NOW2 = 2_000;
  const app = { maxSessionMinutes: 180, inactivityLimitMinutes: 20 };
  function check(
    rec: Partial<typeof base> | { recoveredAt: undefined; anchorTerm: undefined },
    claims: Record<string, unknown> = {},
  ) {
    const c = { role: 'leader', pid: 'B', term: 700, gct: 0, lat: NOW2, ...claims };
    return canSupersede({ ...base, ...rec }, c as never, app, NOW2, SLACK);
  }

  it.each([
    ['base', {}, {}, true],
    ['created here', { recoveredAt: undefined, anchorTerm: undefined }, {}, false],
    ['member token', {}, { role: 'member' }, false],
    ['the current leader', {}, { pid: 'A' }, false],
    ['term = recoveredAt', {}, { term: 1_000 }, false],
    ['term after recoveredAt', {}, { term: 1_500 }, false],
    ['just before the restart', {}, { term: 999 }, true],
    ['term = anchor', {}, { term: 400 }, false],
    ['term below the anchor', {}, { term: 300 }, false],
    ['term = anchor + 1', {}, { term: 401 }, true],
    ['lat window passed', {}, { lat: NOW2 - 20 * MINUTE - SLACK }, false],
    ['max session passed', {}, { gct: NOW2 - 180 * MINUTE }, false],
  ] as const)('%s', (_label, rec, claims, expected) => {
    expect(check(rec as never, claims)).toBe(expected);
  });

  it('after a supersede by term 700 the anchor moves: 650 / 700 / 800', () => {
    expect(check({ anchorTerm: 700 }, { term: 650 })).toBe(false);
    expect(check({ anchorTerm: 700 }, { term: 700 })).toBe(false);
    expect(check({ anchorTerm: 700 }, { term: 800 })).toBe(true);
  });

  it('no grant made under the floor can ever supersede, whatever the clock does', () => {
    let term = 400;
    const recoveredAt = 1_000;
    for (let i = 0; i < 200; i++) {
      const now = 500 + ((i * 7919) % 2_000) - 1_000;
      term = nextTerm(term, now, recoveredAt);
      expect(term).toBeGreaterThanOrEqual(recoveredAt);
      expect(check({ recoveredAt, anchorTerm: 400 }, { term, pid: `p${i}` })).toBe(false);
    }
  });
});
