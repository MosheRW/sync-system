import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { type JoinFields, codesOf, createGroupWithMembers } from './helpers/groups.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, KEY_B, type TestServer, startTestServer } from './helpers/test-server.js';

let ts: TestServer;
let store: InMemoryGroupStore;

beforeEach(async () => {
  store = new InMemoryGroupStore();
  ts = await startTestServer({ store });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await ts.close();
});

async function createGroup(client: TestClient, position: unknown = { page: 1 }) {
  client.send({ type: 'group.create', metadata: { contentId: 'secret-book' }, position });
  return codesOf((await client.next('group.created')).codes);
}

async function joinError(client: TestClient, join: JoinFields) {
  client.send({ type: 'group.joinByCode', ...join, reqId: 'r' });
  const error = await client.next('error');
  const copy: Partial<typeof error> = { ...error };
  delete copy.reqId;
  return copy;
}

describe('app isolation (AC18)', () => {
  it("answers another app's join code exactly like a nonexistent one (#10 AC13)", async () => {
    const leaderA = await ts.connectReady(KEY_A);
    const join = await createGroup(leaderA);

    const clientB = await ts.connectReady(KEY_B);
    const crossApp = await joinError(clientB, join);
    const other = join.joinCode === '000000' ? '000001' : '000000';
    const unknown = await joinError(clientB, { ...join, joinCode: other });
    expect(crossApp).toEqual({
      type: 'error',
      code: 'CODE_NOT_FOUND',
      message: 'Join code not found',
    });
    expect(unknown).toEqual(crossApp);
    expect(JSON.stringify(crossApp)).toBe(JSON.stringify(unknown));
  });
});

describe('no cross-app payloads (AC18)', () => {
  it("never delivers app A's updates to an app B client that tried its codes", async () => {
    const groupA = await createGroupWithMembers(ts, 1, { apiKey: KEY_A });
    const clientB = await ts.connectReady(KEY_B);
    await joinError(clientB, groupA.join);

    groupA.leader.send({ type: 'position.update', position: { secret: 'page' } });
    await groupA.leader.next('position.ack');
    await groupA.members[0]!.next('position.updated');
    await clientB.expectNoMessage();
  });
});

describe('group isolation (AC19)', () => {
  it('keeps updates and events of group X away from group Y and from other apps', async () => {
    const x = await createGroupWithMembers(ts, 2, { apiKey: KEY_A });
    const y = await createGroupWithMembers(ts, 2, { apiKey: KEY_A });
    const z = await createGroupWithMembers(ts, 1, { apiKey: KEY_B });

    x.leader.send({ type: 'position.update', position: { group: 'x' } });
    await x.leader.next('position.ack');
    for (const member of x.members) {
      expect(await member.next('position.updated')).toMatchObject({ groupId: x.groupId });
    }

    // Leader of X disconnects: leader.offline must stay inside X as well (#5 AC18).
    await x.leader.close();
    for (const member of x.members) {
      expect(await member.next('leader.offline')).toEqual({
        type: 'leader.offline',
        groupId: x.groupId,
        cause: 'disconnected',
        graceMs: expect.any(Number) as number,
      });
    }
    for (const client of [y.leader, ...y.members, z.leader, ...z.members]) {
      await client.expectNoMessage(50);
    }
  });
});

describe('join code format (L3, #10 AC12)', () => {
  it('answers malformed codes within the bound with INVALID_MESSAGE', async () => {
    const client = await ts.connectReady();
    for (const joinCode of ['12345', '1234567', 'ABCDEFG0', '', ' '.repeat(32)]) {
      expect(await joinError(client, { joinCode }), JSON.stringify(joinCode)).toEqual({
        type: 'error',
        code: 'INVALID_MESSAGE',
        message: 'Invalid message',
      });
    }
  });

  it('rejects a 5,000-char code by schema without querying the store', async () => {
    const add = vi.spyOn(store, 'addParticipant');
    const get = vi.spyOn(store, 'get');
    const client = await ts.connectReady();
    client.send({ type: 'group.joinByCode', joinCode: 'A'.repeat(5000) });
    expect(await client.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(add).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('does not query the store for a malformed or unknown code', async () => {
    const add = vi.spyOn(store, 'addParticipant');
    const get = vi.spyOn(store, 'get');
    const client = await ts.connectReady();
    await joinError(client, { joinCode: 'short' });
    await joinError(client, { joinCode: '999999' });
    expect(add).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });
});

describe('no listing (AC20)', () => {
  it('rejects list-like message types with INVALID_MESSAGE', async () => {
    const client = await ts.connectReady();
    for (const type of ['group.list', 'groups.list', 'list', 'group.get']) {
      client.send({ type, reqId: type });
      expect(await client.next('error')).toMatchObject({ code: 'INVALID_MESSAGE', reqId: type });
    }
  });
});
