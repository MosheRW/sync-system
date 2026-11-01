import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { createGroupWithMembers } from './helpers/groups.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

let ts: TestServer;
let store: InMemoryGroupStore;

beforeEach(async () => {
  store = new InMemoryGroupStore();
  ts = await startTestServer({ store, apps: [{ namespace: 'app-a', apiKey: KEY_A }] });
});

afterEach(async () => {
  await ts.close();
});

describe('disconnects (AC17)', () => {
  it('removes a disconnected member from the group', async () => {
    const { groupId, leader, members } = await createGroupWithMembers(ts, 1);
    expect((await store.get('app-a', groupId))?.participantIds).toHaveLength(2);

    await members[0]!.close();
    await waitUntil(async () => (await store.get('app-a', groupId))?.participantIds.length === 1);
    // The leader is not notified and the group lives on.
    await leader.expectNoMessage(50);
    leader.send({ type: 'position.update', position: 1 });
    await leader.next('position.ack');
  });

  it('frees the slot of a disconnected member in a size-2 group', async () => {
    await ts.close();
    ts = await startTestServer({
      store,
      apps: [{ namespace: 'app-a', apiKey: KEY_A, maxGroupSize: 2 }],
    });
    const { groupId, members } = await createGroupWithMembers(ts, 1);
    const late = await ts.connectReady();
    late.send({ type: 'group.join', groupId });
    expect(await late.next('error')).toMatchObject({ code: 'GROUP_FULL' });

    await members[0]!.close();
    await waitUntil(async () => (await store.get('app-a', groupId))?.participantIds.length === 1);
    late.send({ type: 'group.join', groupId });
    expect((await late.next('group.joined')).groupId).toBe(groupId);
  });

  it('ends the group when the leader disconnects', async () => {
    const { groupId, leader, members } = await createGroupWithMembers(ts, 1);
    const [member] = members as [(typeof members)[0]];

    await leader.close();
    expect(await member.next('group.ended')).toEqual({
      type: 'group.ended',
      groupId,
      reason: 'leader_disconnected',
    });
    await waitUntil(() => store.size === 0);

    // The member's socket stays open and it is groupless again.
    expect(member.isClosed).toBe(false);
    member.send({ type: 'group.join', groupId });
    expect(await member.next('error')).toMatchObject({ code: 'GROUP_NOT_FOUND' });
    member.send({ type: 'group.create', metadata: {} });
    expect((await member.next('group.created')).role).toBe('leader');
  });

  it('ends the group on an abrupt leader disconnect too', async () => {
    const { leader, members } = await createGroupWithMembers(ts, 1);
    leader.terminate();
    expect((await members[0]!.next('group.ended')).reason).toBe('leader_disconnected');
    await waitUntil(() => store.size === 0);
  });

  it('removes a group with no connections from memory', async () => {
    const { members, leader } = await createGroupWithMembers(ts, 1);
    members[0]!.terminate();
    leader.terminate();
    await waitUntil(() => store.size === 0);
    await waitUntil(() => ts.server.stats().total === 0);
  });

  it('a groupless member that leaves causes no errors', async () => {
    const client = await ts.connectReady();
    await client.close();
    await waitUntil(() => ts.server.stats().total === 0);
    expect(ts.logs.events()).not.toContain('internal_error');
    expect(ts.logs.events()).not.toContain('queue_error');
  });
});
