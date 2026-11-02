import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { createGroupWithMembers } from './helpers/groups.js';
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

async function start(apps?: TestAppInput[]) {
  const scheduler = new ManualScheduler();
  const store = new InMemoryGroupStore();
  ts = await startTestServer({ scheduler, store, ...(apps ? { apps } : {}) });
  return { scheduler, store, ts };
}

describe('frozen groups (#5 AC18)', () => {
  it('tells members the leader is offline and keeps them in the group', async () => {
    const { store, ts } = await start();
    const { groupId, leader, members } = await createGroupWithMembers(ts, 2, { position: 1 });
    await leader.close();
    for (const member of members) {
      expect(await member.next('leader.offline')).toEqual({ type: 'leader.offline', groupId });
    }
    const record = await store.get('app-a', groupId);
    expect(record).toMatchObject({ leaderOnline: false, position: { has: true, payload: 1 } });
    expect(record?.participantIds).toHaveLength(3);
  });

  it('lets new members join a frozen group, told the leader is offline', async () => {
    const { ts } = await start();
    const { groupId, leader, members } = await createGroupWithMembers(ts, 1, { position: 'p' });
    await leader.close();
    await members[0]!.next('leader.offline');
    const late = await ts.connectReady();
    late.send({ type: 'group.join', groupId });
    expect(await late.next('group.joined')).toMatchObject({
      groupId,
      leaderOnline: false,
      hasPosition: true,
      position: 'p',
    });
  });

  it('keeps the offline leader’s slot reserved (architecture 3)', async () => {
    const { ts } = await start([{ namespace: 'app-a', apiKey: KEY_A, maxGroupSize: 2 }]);
    const { groupId, leader, members } = await createGroupWithMembers(ts, 1);
    await leader.close();
    await members[0]!.next('leader.offline');
    const late = await ts.connectReady();
    late.send({ type: 'group.join', groupId });
    expect(await late.next('error')).toMatchObject({ code: 'GROUP_FULL' });
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

  it('a stale timer for a dropped group is a no-op', async () => {
    const { scheduler, store, ts } = await start();
    const { leader, members } = await createGroupWithMembers(ts, 1);
    await leader.close();
    await members[0]!.next('leader.offline');
    // Max-session and frozen-end timers.
    expect(scheduler.pending).toBe(2);
    await members[0]!.close();
    await waitUntil(() => store.size === 0);
    // Dropping the group cancelled its timer.
    expect(scheduler.pending).toBe(0);
    scheduler.advance(WINDOW * 2);
    expect(ts.logs.events()).not.toContain('timer_error');
    expect(ts.logs.events()).not.toContain('group_ended');
  });
});

describe('dropping groups nobody is connected to (#5 AC22)', () => {
  it('drops a group whose leader leaves alone, without ending it', async () => {
    const { store, ts, scheduler } = await start();
    const { leader } = await createGroupWithMembers(ts, 0);
    await leader.close();
    await waitUntil(() => store.size === 0);
    expect(scheduler.pending).toBe(0);
    expect(ts.logs.events()).toContain('group_dropped');
    expect(ts.logs.events()).not.toContain('group_ended');
  });

  it('drops a frozen group when its last member leaves', async () => {
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
    // Max-session and frozen-end timers.
    expect(scheduler.pending).toBe(2);
    await server.close();
    ts = undefined;
    expect(scheduler.pending).toBe(0);
  });
});
