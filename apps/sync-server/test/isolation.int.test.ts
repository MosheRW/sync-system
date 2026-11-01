import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
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
  return (await client.next('group.created')).groupId;
}

async function joinError(client: TestClient, groupId: string) {
  client.send({ type: 'group.join', groupId, reqId: 'r' });
  const error = await client.next('error');
  const copy: Partial<typeof error> = { ...error };
  delete copy.reqId;
  return copy;
}

describe('app isolation (AC18)', () => {
  it("answers another app's group ID exactly like a nonexistent one", async () => {
    const leaderA = await ts.connectReady(KEY_A);
    const groupId = await createGroup(leaderA);

    const clientB = await ts.connectReady(KEY_B);
    const crossApp = await joinError(clientB, groupId);
    const unknown = await joinError(clientB, 'N'.repeat(43));
    const malformed = await joinError(clientB, 'bad');
    expect(crossApp).toEqual({
      type: 'error',
      code: 'GROUP_NOT_FOUND',
      message: 'Group not found',
    });
    expect(unknown).toEqual(crossApp);
    expect(malformed).toEqual(crossApp);
    expect(JSON.stringify(crossApp)).toBe(JSON.stringify(unknown));
  });
});

describe('group ID format (L3)', () => {
  it('answers malformed IDs within the bound like unknown IDs', async () => {
    const client = await ts.connectReady();
    const unknown = await joinError(client, 'U'.repeat(43));
    for (const groupId of [
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}/`,
      '',
      ' '.repeat(43),
    ]) {
      expect(await joinError(client, groupId), JSON.stringify(groupId)).toEqual(unknown);
    }
  });

  it('rejects a 5,000-char ID by schema without querying the store', async () => {
    const add = vi.spyOn(store, 'addParticipant');
    const get = vi.spyOn(store, 'get');
    const client = await ts.connectReady();
    client.send({ type: 'group.join', groupId: 'A'.repeat(5000) });
    expect(await client.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });
    expect(add).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('does not query the store for a malformed ID', async () => {
    const add = vi.spyOn(store, 'addParticipant');
    const client = await ts.connectReady();
    await joinError(client, 'short');
    expect(add).not.toHaveBeenCalled();
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
