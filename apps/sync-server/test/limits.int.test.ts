import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { createGroupWithMembers } from './helpers/groups.js';
import {
  KEY_A,
  KEY_B,
  type TestServer,
  TestClock,
  startTestServer,
} from './helpers/test-server.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

describe('leader update rate (AC22)', () => {
  async function setup() {
    const clock = new TestClock();
    ts = await startTestServer({
      now: clock.now,
      apps: [{ namespace: 'app-a', apiKey: KEY_A, maxLeaderUpdatesPerSecond: 5 }],
    });
    const group = await createGroupWithMembers(ts, 1);
    return { clock, ...group, member: group.members[0]! };
  }

  it('accepts 5 updates per second, rejects the 6th and relays only the accepted', async () => {
    const { groupId, leader, member } = await setup();
    for (let page = 1; page <= 5; page++) {
      leader.send({ type: 'position.update', position: { page } });
      await leader.next('position.ack');
    }
    leader.send({ type: 'position.update', reqId: 'six', position: { page: 6 } });
    expect(await leader.next('error')).toEqual({
      type: 'error',
      reqId: 'six',
      code: 'RATE_LIMITED',
      message: 'Too many position updates',
      details: { maxLeaderUpdatesPerSecond: 5, retryAfterMs: 1000 },
    });

    for (let page = 1; page <= 5; page++) {
      expect((await member.next('position.updated')).position).toEqual({ page });
    }
    await member.expectNoMessage();

    const late = await ts!.connectReady();
    late.send({ type: 'group.join', groupId });
    expect(await late.next('group.joined')).toMatchObject({ position: { page: 5 } });
    expect(leader.isClosed).toBe(false);
  });

  it('accepts again after the window passes; rejected updates use no budget', async () => {
    const { clock, leader, member } = await setup();
    for (let i = 0; i < 5; i++) {
      leader.send({ type: 'position.update', position: i });
      await leader.next('position.ack');
    }
    for (let i = 0; i < 3; i++) {
      leader.send({ type: 'position.update', position: 'rejected' });
      expect(await leader.next('error')).toMatchObject({ code: 'RATE_LIMITED' });
    }
    clock.advance(1000);
    for (let i = 0; i < 5; i++) {
      leader.send({ type: 'position.update', position: `ok-${i}` });
      await leader.next('position.ack');
    }
    leader.send({ type: 'position.update', position: 'over' });
    expect(await leader.next('error')).toMatchObject({ code: 'RATE_LIMITED' });

    const received: unknown[] = [];
    while (received.length < 10) received.push((await member.next('position.updated')).position);
    expect(received).not.toContain('rejected');
    expect(received).not.toContain('over');
    expect(leader.isClosed).toBe(false);
  });

  it('does not charge NOT_LEADER updates to the group budget', async () => {
    const { leader, member } = await setup();
    for (let i = 0; i < 5; i++) {
      member.send({ type: 'position.update', position: i });
      expect(await member.next('error')).toMatchObject({ code: 'NOT_LEADER' });
    }
    for (let i = 0; i < 5; i++) {
      leader.send({ type: 'position.update', position: i });
      await leader.next('position.ack');
    }
  });
});

describe('max group size (AC21)', () => {
  it('counts the leader and rejects the join over the limit with GROUP_FULL', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({
      store,
      apps: [
        { namespace: 'app-a', apiKey: KEY_A, maxGroupSize: 3 },
        { namespace: 'app-b', apiKey: KEY_B },
      ],
    });
    const { groupId } = await createGroupWithMembers(ts, 2);

    const extra = await ts.connectReady();
    extra.send({ type: 'group.join', groupId, reqId: 'full' });
    expect(await extra.next('error')).toEqual({
      type: 'error',
      reqId: 'full',
      code: 'GROUP_FULL',
      message: 'Group is full',
      details: { maxGroupSize: 3 },
    });
    expect((await store.get('app-a', groupId))?.participantIds).toHaveLength(3);
    // The rejected client stays connected and groupless.
    extra.send({ type: 'group.create', metadata: {} });
    expect((await extra.next('group.created')).role).toBe('leader');
  });

  it('uses the app value, defaulting to 30', async () => {
    ts = await startTestServer();
    const client = await ts.connect();
    const ok = await client.hello({ apiKey: KEY_A });
    expect(ok.type === 'hello.ok' && ok.limits.maxGroupSize).toBe(30);
  });
});
