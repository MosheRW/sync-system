import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGroupWithMembers } from './helpers/groups.js';
import { type TestServer, startTestServer } from './helpers/test-server.js';

let ts: TestServer;

beforeEach(async () => {
  ts = await startTestServer();
});

afterEach(async () => {
  await ts.close();
});

describe('position relay (AC13)', () => {
  it('relays every leader update to every member; the leader gets an ack only', async () => {
    const { groupId, leader, members } = await createGroupWithMembers(ts, 2);

    leader.send({ type: 'position.update', reqId: 'u1', position: { page: 7 } });
    expect(await leader.next('position.ack')).toEqual({ type: 'position.ack', reqId: 'u1' });
    for (const member of members) {
      expect(await member.next('position.updated')).toEqual({
        type: 'position.updated',
        groupId,
        position: { page: 7 },
      });
    }
    await leader.expectNoMessage();
  });

  it('gives a later joiner the latest payload', async () => {
    const { groupId, leader } = await createGroupWithMembers(ts, 0, { position: { page: 1 } });
    for (const page of [2, 3, 4]) {
      leader.send({ type: 'position.update', position: { page } });
      await leader.next('position.ack');
    }
    const late = await ts.connectReady();
    late.send({ type: 'group.join', groupId });
    expect(await late.next('group.joined')).toMatchObject({
      hasPosition: true,
      position: { page: 4 },
    });
  });

  it('turns hasPosition true after the first update', async () => {
    const { groupId, leader } = await createGroupWithMembers(ts, 0);
    leader.send({ type: 'position.update', position: 'first' });
    await leader.next('position.ack');
    const member = await ts.connectReady();
    member.send({ type: 'group.join', groupId });
    expect(await member.next('group.joined')).toMatchObject({
      hasPosition: true,
      position: 'first',
    });
  });

  it('answers an update outside a group with NOT_IN_GROUP', async () => {
    const client = await ts.connectReady();
    client.send({ type: 'position.update', position: 1, reqId: 'n' });
    expect(await client.next('error')).toMatchObject({ code: 'NOT_IN_GROUP', reqId: 'n' });
  });
});

describe('only the leader updates (AC15)', () => {
  it('rejects a member update with NOT_LEADER and relays nothing', async () => {
    const { groupId, leader, members } = await createGroupWithMembers(ts, 2, {
      position: { page: 1 },
    });
    const [sender, other] = members as [(typeof members)[0], (typeof members)[0]];

    sender.send({ type: 'position.update', reqId: 'm1', position: { page: 99 } });
    expect(await sender.next('error')).toMatchObject({
      code: 'NOT_LEADER',
      message: 'Only the leader can update the position',
      reqId: 'm1',
    });
    await other.expectNoMessage();
    await leader.expectNoMessage();

    const late = await ts.connectReady();
    late.send({ type: 'group.join', groupId });
    expect(await late.next('group.joined')).toMatchObject({ position: { page: 1 } });
  });
});
