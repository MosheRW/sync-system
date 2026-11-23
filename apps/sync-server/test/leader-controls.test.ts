import type { ServerMessage } from '@mosherw/sync-system-protocol';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/apps/app-registry.js';
import type { GroupRecord } from '../src/groups/group-store.js';
import type { Session } from '../src/groups/session.js';
import type { GroupCodes } from '../src/joins/codes.js';
import { LeaderControls, type LeaderControlsHost } from '../src/lifecycle/leader-controls.js';
import { TAKE_BACKS_PER_GROUP_PER_MINUTE } from '../src/limits/constants.js';
import type { RosterEntry } from '../src/lifecycle/roster.js';
import { createLogger } from '../src/logging/logger.js';
import { LogCapture } from './helpers/log-capture.js';

const LEADER = 'leader-pid';
const MEMBER = 'member-pid';

function entry(pid: string, admittedSeq: number): RosterEntry {
  return {
    pid,
    name: pid,
    generated: false,
    admittedSeq,
    admittedAt: 0,
    connected: true,
    admittedSinceRecovery: false,
  };
}

function record(id: string): GroupRecord {
  return {
    id,
    appNamespace: 'app-a',
    leaderId: LEADER,
    roster: [entry(LEADER, 0), entry(MEMBER, 1)],
    blockList: [],
    viceId: undefined,
    displacedLeaderId: MEMBER,
    keepAlivePending: false,
    locked: false,
  } as unknown as GroupRecord;
}

/**
 * A host that runs every task on a fixed record: the leader for asLeader,
 * the displaced leader for asMember. Every effect succeeds.
 */
function controlsFor(records: Map<string, GroupRecord>): LeaderControls {
  const byGroup = (session: Session): GroupRecord =>
    records.get((session as unknown as { gid: string }).gid)!;
  const host: LeaderControlsHost = {
    asLeader: (session, _action, task) =>
      task(byGroup(session), {
        groupId: byGroup(session).id,
        participantId: LEADER,
        attachId: 'a',
      }),
    asMember: (session, task) =>
      task(byGroup(session), {
        groupId: byGroup(session).id,
        participantId: MEMBER,
        attachId: 'a',
      }),
    patch: (r, patch) => Promise.resolve({ ...r, ...patch }),
    sessionOf: () => undefined,
    deliverLater: () => undefined,
    rosterUpdated: () => undefined,
    toMembers: () => undefined,
    block: () => Promise.resolve(undefined),
    claimFullSet: () => Promise.resolve({} as GroupCodes),
    commitFullSet: (r) => Promise.resolve(r),
    releaseClaim: () => Promise.resolve(),
    codesPayload: () => ({}) as never,
    get: (r) => Promise.resolve(r),
    takeBackFor: () => Promise.resolve({ type: 'activity.ack' } as ServerMessage),
    now: () => 1_000,
  };
  return new LeaderControls(host, createLogger({ level: 'trace', destination: new LogCapture() }));
}

function session(gid: string): Session {
  return { gid, app: { namespace: 'app-a' } as AppConfig } as unknown as Session;
}

/** Charges every per-group limiter of `controls` once for group `gid`. */
async function chargeEveryLimiter(controls: LeaderControls, gid: string): Promise<void> {
  const s = session(gid);
  const replies = [
    await controls.setVice(s, { type: 'vice.set', participantId: MEMBER }),
    await controls.setLock(s, { type: 'group.lock' }),
    await controls.removeMember(s, { type: 'member.remove', participantId: MEMBER }),
    await controls.leaderActivity(s, { type: 'leader.activity' }),
    await controls.takeBack(s, { type: 'leader.takeBack' }),
  ];
  for (const reply of replies) expect(reply.type).not.toBe('error');
}

describe('LeaderControls per-group budgets (#13 RC2)', () => {
  it('forgetGroup drops every budget of that group and keeps the others', async () => {
    const records = new Map([
      ['G1', record('G1')],
      ['G2', record('G2')],
    ]);
    const controls = controlsFor(records);
    await chargeEveryLimiter(controls, 'G1');
    // One key in each of the five limiters.
    expect(controls.limiterSize).toBe(5);
    await chargeEveryLimiter(controls, 'G2');
    expect(controls.limiterSize).toBe(10);
    controls.forgetGroup('app-a', 'G1');
    expect(controls.limiterSize).toBe(5);
    controls.forgetGroup('app-a', 'G2');
    expect(controls.limiterSize).toBe(0);
  });

  it('close() drops every budget of every group', async () => {
    const records = new Map([
      ['G1', record('G1')],
      ['G2', record('G2')],
    ]);
    const controls = controlsFor(records);
    await chargeEveryLimiter(controls, 'G1');
    await chargeEveryLimiter(controls, 'G2');
    controls.close();
    expect(controls.limiterSize).toBe(0);
  });

  it('a refused request leaves no budget behind', async () => {
    const records = new Map([['G1', { ...record('G1'), displacedLeaderId: undefined }]]);
    const controls = controlsFor(records);
    const reply = await controls.takeBack(session('G1'), { type: 'leader.takeBack' });
    expect(reply).toMatchObject({ code: 'NOT_ALLOWED' });
    expect(controls.limiterSize).toBe(0);
  });
  it('limits take-backs to 3 per group per minute; a refusal spends none (#32 AC5, L3)', async () => {
    const records = new Map([
      ['G1', { ...record('G1'), displacedLeaderId: undefined }],
      ['G2', record('G2')],
    ]);
    const controls = controlsFor(records);
    const takeBack = (gid: string) => controls.takeBack(session(gid), { type: 'leader.takeBack' });
    // Not the slot holder: NOT_ALLOWED, before the limiter.
    expect(await takeBack('G1')).toMatchObject({ code: 'NOT_ALLOWED' });
    expect(controls.limiterSize).toBe(0);
    records.set('G1', record('G1'));
    for (let i = 0; i < TAKE_BACKS_PER_GROUP_PER_MINUTE; i++) {
      expect((await takeBack('G1')).type).not.toBe('error');
    }
    expect(await takeBack('G1')).toMatchObject({
      type: 'error',
      code: 'RATE_LIMITED',
      message: 'Too many take-backs',
    });
    // Another group has its own budget.
    expect((await takeBack('G2')).type).not.toBe('error');
  });
});
