import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { createGroupWithMembers } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { type TestServer, startTestServer } from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

describe('group.end (#5 AC29)', () => {
  it('ends the group: members get ended_by_leader, the leader gets the reply', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ store });
    const { groupId, join, leader, members } = await createGroupWithMembers(ts, 2);
    leader.send({ type: 'group.end', reqId: 'e1' });
    expect(await leader.next('group.ended')).toEqual({
      type: 'group.ended',
      reqId: 'e1',
      groupId,
      reason: 'ended_by_leader',
    });
    for (const member of members) {
      expect(await member.next('group.ended')).toEqual({
        type: 'group.ended',
        groupId,
        reason: 'ended_by_leader',
      });
    }
    await leader.expectNoMessage(30);
    expect(store.size).toBe(0);
    // Everyone is groupless; nobody was disconnected.
    leader.send({ type: 'group.create', metadata: {} });
    expect((await leader.next('group.created')).role).toBe('leader');
    members[0]!.send({ type: 'group.joinByCode', ...join });
    expect(await members[0]!.next('error')).toMatchObject({ code: 'CODE_NOT_FOUND' });
  });

  it('remembers the ended group until its max-session deadline', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ scheduler });
    const created = scheduler.now();
    const { leader } = await createGroupWithMembers(ts, 0);
    leader.send({ type: 'group.end' });
    await leader.next('group.ended');
    // Checked through tokens.check and group.resume in later tests; here the
    // timer side: no timer is left for the ended group.
    expect(scheduler.pending).toBe(0);
    expect(scheduler.now()).toBe(created);
  });

  it('refuses a member with NOT_LEADER and a groupless session with NOT_IN_GROUP', async () => {
    ts = await startTestServer();
    const { members, leader } = await createGroupWithMembers(ts, 1);
    members[0]!.send({ type: 'group.end', reqId: 'm' });
    expect(await members[0]!.next('error')).toMatchObject({
      reqId: 'm',
      code: 'NOT_LEADER',
      message: 'Only the leader can end the group',
    });
    const outsider = await ts.connectReady();
    outsider.send({ type: 'group.end' });
    expect(await outsider.next('error')).toMatchObject({ code: 'NOT_IN_GROUP' });
    await leader.expectNoMessage(30);
  });
});

describe('group.leave (#5 AC30)', () => {
  it('removes the member without affecting the leader', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ store });
    const { groupId, join, leader, members } = await createGroupWithMembers(ts, 2);
    members[0]!.send({ type: 'group.leave', reqId: 'l1' });
    expect(await members[0]!.next('group.left')).toEqual({
      type: 'group.left',
      reqId: 'l1',
      groupId,
    });
    expect((await store.get('app-a', groupId))?.participantIds).toHaveLength(2);
    await leader.expectNoMessage(30);
    leader.send({ type: 'position.update', position: 1 });
    await leader.next('position.ack');
    expect(await members[1]!.next('position.updated')).toMatchObject({ position: 1 });
    await members[0]!.expectNoMessage(30);

    // Leaving does not block: the same client can join again.
    members[0]!.send({ type: 'group.joinByCode', ...join });
    expect((await members[0]!.next('group.joined')).groupId).toBe(groupId);
  });

  it('refuses the leader with LEADER_CANNOT_LEAVE (Q-D)', async () => {
    ts = await startTestServer();
    const { leader } = await createGroupWithMembers(ts, 0);
    leader.send({ type: 'group.leave', reqId: 'x' });
    expect(await leader.next('error')).toEqual({
      type: 'error',
      reqId: 'x',
      code: 'LEADER_CANNOT_LEAVE',
      message: 'The leader cannot leave; end the group instead',
    });
    leader.send({ type: 'position.update', position: 1 });
    await leader.next('position.ack');
  });

  it('refuses a groupless session with NOT_IN_GROUP', async () => {
    ts = await startTestServer();
    const client = await ts.connectReady();
    client.send({ type: 'group.leave' });
    expect(await client.next('error')).toMatchObject({ code: 'NOT_IN_GROUP' });
  });

  it('drops a frozen group when its last member leaves', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ store });
    const { leader, members } = await createGroupWithMembers(ts, 1);
    await leader.close();
    await members[0]!.next('leader.offline');
    members[0]!.send({ type: 'group.leave' });
    await members[0]!.next('group.left');
    await waitUntil(() => store.size === 0);
  });
});
