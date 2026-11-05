import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AddParticipantResult, GroupRecord } from '../src/groups/group-store.js';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { FailingStore } from './helpers/failing-store.js';
import { createGroupWithMembers } from './helpers/groups.js';
import { KEY_A, type TestServer, httpGet, startTestServer } from './helpers/test-server.js';
import { sleep, waitUntil } from './helpers/wait.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

/**
 * Holds the next call of one method after the real operation ran, until
 * release(): models a slow store reply (e.g. a Redis round trip).
 */
class DeferredStore extends InMemoryGroupStore {
  reached = false;
  private held: 'get' | 'addParticipant' | undefined;
  private gate: Promise<void> = Promise.resolve();
  private open: () => void = () => undefined;

  holdNext(method: 'get' | 'addParticipant'): void {
    this.held = method;
    this.reached = false;
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open();
  }

  private async pass<T>(method: 'get' | 'addParticipant', result: Promise<T>): Promise<T> {
    if (this.held !== method) return result;
    this.held = undefined;
    this.reached = true;
    const value = await result;
    await this.gate;
    return value;
  }

  override get(namespace: string, id: string): Promise<GroupRecord | undefined> {
    return this.pass('get', super.get(namespace, id));
  }

  override addParticipant(
    namespace: string,
    id: string,
    participantId: string,
    maxSize: number,
  ): Promise<AddParticipantResult> {
    return this.pass('addParticipant', super.addParticipant(namespace, id, participantId, maxSize));
  }
}

describe('join racing a leader disconnect, with a slow store', () => {
  it('replies group.joined before leader.offline and keeps the joiner in the frozen group', async () => {
    const store = new DeferredStore();
    ts = await startTestServer({ store });
    const { groupId, join, leader } = await createGroupWithMembers(ts, 0);
    const joiner = await ts.connectReady();

    // The insert has run; its reply (with the snapshot) is still in flight.
    store.holdNext('addParticipant');
    joiner.send({ type: 'group.joinByCode', ...join });
    await waitUntil(() => store.reached);
    leader.terminate();
    await sleep(50);
    store.release();

    expect(await joiner.next('group.joined')).toMatchObject({ groupId, leaderOnline: true });
    expect(await joiner.next('leader.offline')).toMatchObject({ groupId });
    expect(await store.get('app-a', groupId)).toMatchObject({ leaderOnline: false });
    // In the frozen group, not stranded outside it.
    joiner.send({ type: 'group.create', metadata: {} });
    expect(await joiner.next('error')).toMatchObject({ code: 'ALREADY_IN_GROUP' });
  });

  it('never strands a joiner whose insert lands while the frozen group is dropped', async () => {
    const store = new DeferredStore();
    // A 1 s grace keeps the real-clock hold of an emptied group short (#13 Q-G).
    ts = await startTestServer({
      store,
      apps: [{ namespace: 'app-a', apiKey: KEY_A, disconnectGraceSeconds: 1 }],
    });
    const { groupId, join, leader, members } = await createGroupWithMembers(ts, 1);
    leader.terminate();
    await members[0]!.next('leader.offline');
    const joiner = await ts.connectReady();

    // The join's insert has run; the last old member leaves meanwhile.
    store.holdNext('addParticipant');
    joiner.send({ type: 'group.joinByCode', ...join });
    await waitUntil(() => store.reached);
    members[0]!.terminate();
    await sleep(50);
    store.release();

    expect(await joiner.next('group.joined')).toMatchObject({ groupId, leaderOnline: false });
    // The joiner keeps the group in memory; it is dropped when it leaves.
    await sleep(50);
    expect(store.size).toBe(1);
    joiner.terminate();
    await waitUntil(() => store.size === 0, 3000);
  });
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

  it('joins without a second store read, so a failing get cannot strand a member', async () => {
    const store = new FailingStore();
    ts = await startTestServer({ store });
    const { groupId, join, leader } = await createGroupWithMembers(ts, 0);
    const member = await ts.connectReady();

    // Join used to call get after addParticipant had already succeeded. A
    // code join reads the group once, before the insert, and never after it.
    const get = vi.spyOn(store, 'get');
    const add = vi.spyOn(store, 'addParticipant');
    member.send({ type: 'group.joinByCode', ...join });
    expect(await member.next('group.joined')).toMatchObject({ groupId, role: 'member' });
    expect(add).toHaveBeenCalledTimes(1);
    const insertedAt = add.mock.invocationCallOrder[0]!;
    expect(get.mock.invocationCallOrder.every((order) => order < insertedAt)).toBe(true);
    get.mockRestore();
    add.mockRestore();

    // Session and store agree: the member is in the group and gets updates.
    const stored = await store.inner.get('app-a', groupId);
    expect(stored!.participantIds).toHaveLength(2);
    member.send({ type: 'group.joinByCode', ...join });
    expect(await member.next('error')).toMatchObject({ code: 'ALREADY_IN_GROUP' });
    leader.send({ type: 'position.update', position: 1 });
    await leader.next('position.ack');
    expect(await member.next('position.updated')).toMatchObject({ position: 1 });
  });

  it('leaves no stray participant when the atomic join fails', async () => {
    const store = new FailingStore();
    ts = await startTestServer({ store });
    const { groupId, join } = await createGroupWithMembers(ts, 0);
    const member = await ts.connectReady();

    store.failNext('addParticipant');
    member.send({ type: 'group.joinByCode', reqId: 'j', ...join });
    expect(await member.next('error')).toMatchObject({ reqId: 'j', code: 'INTERNAL_ERROR' });

    // Neither in the store nor in the session.
    expect((await store.inner.get('app-a', groupId))!.participantIds).toHaveLength(1);
    member.send({ type: 'group.joinByCode', ...join });
    expect((await member.next('group.joined')).groupId).toBe(groupId);
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
      // The surviving member is told the leader is offline and stays usable.
      expect((await members[1]!.next('leader.offline')).type).toBe('leader.offline');
      members[1]!.terminate();
    }
    await waitUntil(() => ts!.server.stats().total === 0);
    expect(ts.logs.events()).not.toContain('internal_error');
    expect(ts.logs.events()).not.toContain('queue_error');
  });

  it('survives a join racing a leader disconnect', async () => {
    ts = await startTestServer();
    for (let round = 0; round < 10; round++) {
      const { groupId, join, leader } = await createGroupWithMembers(ts, 0);
      const joiner = await ts.connectReady();
      joiner.send({ type: 'group.joinByCode', ...join });
      leader.terminate();
      // Either joined then told the leader is offline, or not found
      // (the empty group was dropped): never a crash.
      const first = await joiner.next();
      if (first.type === 'group.joined') {
        expect((await joiner.next('leader.offline')).groupId).toBe(groupId);
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
