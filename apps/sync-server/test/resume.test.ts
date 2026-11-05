import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/apps/app-registry.js';
import type { GroupRecord } from '../src/groups/group-store.js';
import { classifyToken } from '../src/groups/resume.js';
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
    processStartedAt: NOW - 60 * MINUTE,
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
