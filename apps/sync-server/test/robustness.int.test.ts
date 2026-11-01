import { afterEach, describe, expect, it } from 'vitest';
import { FailingStore } from './helpers/failing-store.js';
import { createGroupWithMembers } from './helpers/groups.js';
import { type TestServer, httpGet, startTestServer } from './helpers/test-server.js';
import { sleep, waitUntil } from './helpers/wait.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

describe('robustness (H4)', () => {
  it('maps a throwing handler to INTERNAL_ERROR and keeps the socket usable', async () => {
    const store = new FailingStore();
    ts = await startTestServer({ store });
    const client = await ts.connectReady();

    store.failNext('create');
    client.send({ type: 'group.create', reqId: 'boom', metadata: {} });
    expect(await client.next('error')).toEqual({
      type: 'error',
      reqId: 'boom',
      code: 'INTERNAL_ERROR',
      message: 'Internal error',
    });
    expect(client.isClosed).toBe(false);

    client.send({ type: 'group.create', metadata: {} });
    expect((await client.next('group.created')).role).toBe('leader');
    expect(ts.logs.events()).toContain('internal_error');
  });

  it('survives a failing store during disconnect cleanup', async () => {
    const store = new FailingStore();
    ts = await startTestServer({ store });
    const { leader, members } = await createGroupWithMembers(ts, 1);
    store.failNext('removeParticipant');
    await members[0]!.close();
    await sleep(50);
    expect(ts.logs.events()).toContain('queue_error');
    leader.send({ type: 'position.update', position: 'still-works' });
    await leader.next('position.ack');
    expect((await httpGet(ts.port, '/health')).status).toBe(200);
  });

  it('relays safely to a member that has just closed', async () => {
    ts = await startTestServer();
    const { leader, members } = await createGroupWithMembers(ts, 2);
    const [closing, staying] = members as [(typeof members)[0], (typeof members)[0]];

    closing.ws.close();
    for (let i = 0; i < 5; i++) {
      leader.send({ type: 'position.update', position: i });
      await leader.next('position.ack');
      await staying.next('position.updated');
      await sleep(5);
    }
    await closing.closed();
    expect((await httpGet(ts.port, '/health')).status).toBe(200);
  });

  it('handles the leader and a member disconnecting at the same instant', async () => {
    ts = await startTestServer();
    for (let round = 0; round < 10; round++) {
      const { leader, members } = await createGroupWithMembers(ts, 2);
      leader.terminate();
      members[0]!.terminate();
      // The surviving member gets group.ended and stays usable.
      expect((await members[1]!.next('group.ended')).reason).toBe('leader_disconnected');
      members[1]!.terminate();
    }
    await waitUntil(() => ts!.server.stats().total === 0);
    expect(ts.logs.events()).not.toContain('internal_error');
    expect(ts.logs.events()).not.toContain('queue_error');
  });

  it('survives a join racing a leader disconnect', async () => {
    ts = await startTestServer();
    for (let round = 0; round < 10; round++) {
      const { groupId, leader } = await createGroupWithMembers(ts, 0);
      const joiner = await ts.connectReady();
      joiner.send({ type: 'group.join', groupId });
      leader.terminate();
      // Either joined then ended, or not found: never a crash.
      const first = await joiner.next();
      if (first.type === 'group.joined') {
        expect((await joiner.next('group.ended')).groupId).toBe(groupId);
      } else {
        expect(first).toMatchObject({ code: 'GROUP_NOT_FOUND' });
      }
      joiner.terminate();
    }
    await waitUntil(() => ts!.server.stats().total === 0);
  });

  it('closes every socket on shutdown with 1001', async () => {
    ts = await startTestServer();
    const client = await ts.connectReady();
    const closed = client.closed();
    await ts.server.close();
    expect((await closed).code).toBe(1001);
  });
});
