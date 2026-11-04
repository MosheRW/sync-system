import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import {
  KEY_A,
  type TestAppInput,
  type TestServer,
  startTestServer,
} from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

const MINUTE = 60_000;
/** Default inactivity limit (20 min) plus the default max refresh interval (300 s). */
const WINDOW = 20 * MINUTE + 300_000;

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

/**
 * Frozen mode (#13 AC21): these #5 tests are about a group that waits for
 * its leader, which is what `frozen` keeps doing; `auto` hands off after
 * the grace period (handoff.int.test.ts).
 */
async function start(apps?: TestAppInput[]) {
  const scheduler = new ManualScheduler();
  const store = new InMemoryGroupStore();
  const frozen = (apps ?? [{ namespace: 'app-a', apiKey: KEY_A }]).map((app) => ({
    defaultHandoff: 'frozen',
    ...app,
  }));
  ts = await startTestServer({ scheduler, store, apps: frozen });
  return { scheduler, store, ts };
}

describe('frozen groups (#5 AC18)', () => {
  it('tells members the leader is offline and keeps them in the group', async () => {
    const { store, ts } = await start();
    const { groupId, leader, members } = await createGroupWithMembers(ts, 2, { position: 1 });
    await leader.close();
    for (const member of members) {
      expect(await member.next('leader.offline')).toEqual({
        type: 'leader.offline',
        groupId,
        cause: 'disconnected',
      });
    }
    const record = await store.get('app-a', groupId);
    expect(record).toMatchObject({ leaderOnline: false, position: { has: true, payload: 1 } });
    expect(record?.participantIds).toHaveLength(3);
  });

  it('lets new members join a frozen group, told the leader is offline', async () => {
    const { ts } = await start();
    const { groupId, join, leader, members } = await createGroupWithMembers(ts, 1, {
      position: 'p',
    });
    await leader.close();
    await members[0]!.next('leader.offline');
    const late = await ts.connectReady();
    late.send({ type: 'group.joinByCode', ...join });
    expect(await late.next('group.joined')).toMatchObject({
      groupId,
      leaderOnline: false,
      hasPosition: true,
      position: 'p',
    });
  });

  it('keeps the offline leader’s slot reserved (architecture 3)', async () => {
    const { ts } = await start([{ namespace: 'app-a', apiKey: KEY_A, maxGroupSize: 2 }]);
    const { join, leader, members } = await createGroupWithMembers(ts, 1);
    await leader.close();
    await members[0]!.next('leader.offline');
    const late = await ts.connectReady();
    late.send({ type: 'group.joinByCode', ...join });
    expect(await late.next('error')).toMatchObject({ code: 'GROUP_FULL' });
  });
});

describe('member resume into a frozen group (#7 A3)', () => {
  it('keeps the member’s ID and position; the returning leader’s server position wins', async () => {
    const { ts } = await start();
    // Two members, so the group is not dropped while one of them is away.
    const group = await createGroupWithMembers(ts, 2, { position: { page: 3 } });
    const [away, staying] = group.members as [(typeof group.members)[0], (typeof group.members)[0]];
    await group.leader.close();
    await away.next('leader.offline');
    await staying.next('leader.offline');

    // The member drops and resumes while the leader is offline (AC22).
    away.terminate();
    await away.closed();
    const { client: member, reply } = await resumeWith(ts, group.memberTokens[0], { reqId: 'm' });
    expect(reply).toMatchObject({
      type: 'group.joined',
      reqId: 'm',
      groupId: group.groupId,
      participantId: group.memberIds[0],
      role: 'member',
      leaderOnline: false,
      hasPosition: true,
      position: { page: 3 },
    });

    // The leader returns with a stale position: the server's wins (Q14, AC23).
    const { client: leader, reply: resumed } = await resumeWith(ts, group.leaderToken, {
      position: { page: 1 },
    });
    expect(resumed).toMatchObject({
      type: 'group.resumed',
      participantId: group.leaderId,
      role: 'leader',
      hasPosition: true,
      position: { page: 3 },
    });
    for (const client of [member, staying]) {
      expect(await client.next('leader.online')).toEqual({
        type: 'leader.online',
        groupId: group.groupId,
      });
    }

    // The resumed member gets the leader's updates again.
    leader.send({ type: 'position.update', position: { page: 4 } });
    await leader.next('position.ack');
    expect(await member.next('position.updated')).toEqual({
      type: 'position.updated',
      groupId: group.groupId,
      position: { page: 4 },
    });
  });
});

describe('frozen group end (#5 AC21)', () => {
  it('ends with leader_timeout when the recovery window after the last activity lapses', async () => {
    const { scheduler, store, ts } = await start();
    const { groupId, leader, members } = await createGroupWithMembers(ts, 2);
    leader.send({ type: 'position.update', position: 1 });
    await leader.next('position.ack');
    const lastActivity = scheduler.now();
    scheduler.advance(MINUTE);
    await leader.close();
    for (const member of members) await member.next('position.updated');
    for (const member of members) await member.next('leader.offline');

    scheduler.advanceTo(lastActivity + WINDOW - 1);
    for (const member of members) await member.expectNoMessage(30);
    expect(store.size).toBe(1);

    scheduler.advanceTo(lastActivity + WINDOW);
    for (const member of members) {
      expect(await member.next('group.ended')).toEqual({
        type: 'group.ended',
        groupId,
        reason: 'leader_timeout',
      });
    }
    await waitUntil(() => store.size === 0);
    // Members are groupless again and their sockets stay open.
    members[0]!.send({ type: 'group.create', metadata: {} });
    expect((await members[0]!.next('group.created')).role).toBe('leader');
  });

  it('uses the app’s inactivity limit', async () => {
    const { scheduler, store, ts } = await start([
      { namespace: 'app-a', apiKey: KEY_A, inactivityLimitMinutes: 1 },
    ]);
    const { leader, members } = await createGroupWithMembers(ts, 1);
    const created = scheduler.now();
    await leader.close();
    await members[0]!.next('leader.offline');
    scheduler.advanceTo(created + MINUTE + 300_000);
    expect((await members[0]!.next('group.ended')).reason).toBe('leader_timeout');
    await waitUntil(() => store.size === 0);
  });

  it('ends at once when the leader was already idle past the window', async () => {
    const { scheduler, store, ts } = await start();
    const { leader, members } = await createGroupWithMembers(ts, 1);
    scheduler.advance(WINDOW + 1);
    await leader.close();
    expect(await members[0]!.next('leader.offline')).toMatchObject({ type: 'leader.offline' });
    expect((await members[0]!.next('group.ended')).reason).toBe('leader_timeout');
    await waitUntil(() => store.size === 0);
  });

  it('a stale timer for an emptied group is a no-op', async () => {
    const { scheduler, store, ts } = await start();
    const { leader, members } = await createGroupWithMembers(ts, 1);
    await leader.close();
    await members[0]!.next('leader.offline');
    // Max-session and frozen-end timers (frozen mode: no grace end).
    expect(scheduler.pending).toBe(2);
    await members[0]!.close();
    await waitUntil(() => store.size === 0);
    // Ending the emptied group cancelled its timers.
    expect(scheduler.pending).toBe(0);
    scheduler.advance(WINDOW * 2);
    expect(ts.logs.events()).not.toContain('timer_error');
    const ends = ts.logs.records().filter((r) => r.event === 'group_ended');
    expect(ends.map((r) => r.endReason)).toEqual(['empty']);
  });
});

describe('a group nobody is connected to ends (#13 D15; was dropped in #5 AC22)', () => {
  it('ends a group whose leader leaves alone, as empty', async () => {
    const { store, ts, scheduler } = await start();
    const { leader } = await createGroupWithMembers(ts, 0);
    await leader.close();
    await waitUntil(() => store.size === 0);
    expect(scheduler.pending).toBe(0);
    expect(ts.logs.events()).not.toContain('group_dropped');
    expect(ts.logs.records().find((r) => r.event === 'group_ended')).toMatchObject({
      endReason: 'empty',
      members: 0,
    });
  });

  it('ends a frozen group when its last member leaves', async () => {
    const { store, ts } = await start();
    const { leader, members } = await createGroupWithMembers(ts, 2);
    await leader.close();
    await members[0]!.next('leader.offline');
    await members[0]!.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.size).toBe(1);
    await members[1]!.close();
    await waitUntil(() => store.size === 0);
  });

  it('leaves no timer behind on server close', async () => {
    const { scheduler, ts: server } = await start();
    const { leader, members } = await createGroupWithMembers(server, 1);
    await leader.close();
    await members[0]!.next('leader.offline');
    // Max-session and frozen-end timers (frozen mode: no grace end).
    expect(scheduler.pending).toBe(2);
    await server.close();
    ts = undefined;
    expect(scheduler.pending).toBe(0);
  });
});
