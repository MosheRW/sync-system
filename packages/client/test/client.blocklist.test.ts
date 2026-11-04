import { randomUUID } from 'node:crypto';
import { decodeTokenClaims } from '@sync-system/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SyncClient } from '../src/client.js';
import { type TokenStorage, memoryStorage } from '../src/storage.js';
import { CREATED_FIELDS, connectedClient } from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';
import { fakeToken, groupIdOf } from './helpers/tokens.js';

const KEY = 'sync-system:v1:app-a@127.0.0.1:1';
const GID = groupIdOf('G');
const OTHER = groupIdOf('O');

beforeEach(() => {
  FakeWebSocket.reset();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function storedBlockList(storage: TokenStorage, groupId: string): unknown {
  const doc = JSON.parse(storage.getItem(KEY) as string) as {
    entries: Array<{ token: string; recovery?: { blockList: string[] } }>;
  };
  const entry = doc.entries.find((e) => decodeTokenClaims(e.token)?.gid === groupId);
  return entry?.recovery?.blockList;
}

async function liveLeader(): Promise<{
  client: SyncClient;
  socket: FakeWebSocket;
  storage: TokenStorage;
}> {
  const storage = memoryStorage();
  // A second, stored-only leader group and a member group.
  void storage.setItem(
    KEY,
    JSON.stringify({
      v: 1,
      entries: [
        {
          token: fakeToken({ gid: OTHER }),
          recovery: { metadata: {}, hasPosition: false, blockList: [] },
        },
        { token: fakeToken({ gid: groupIdOf('M'), role: 'member' }) },
      ],
    }),
  );
  const { client, socket } = await connectedClient({ storage });
  const creating = client.createGroup({});
  socket.receive({
    type: 'group.created',
    ...CREATED_FIELDS,
    reqId: socket.lastMessage().reqId,
    groupId: GID,
    participantId: 'p',
    role: 'leader',
    token: fakeToken({ gid: GID }),
  });
  await creating;
  await settle();
  return { client, socket, storage };
}

describe('block list API (#5 AC34, AC26)', () => {
  it('adds to the live group: sends the full list and resolves on the ack', async () => {
    const { client, socket } = await liveLeader();
    const [a, b] = [randomUUID(), randomUUID()];
    const adding = client.addToBlockList(GID, [a, b, a]);
    await settle();
    const sent = socket.lastMessage();
    expect(sent).toEqual({ type: 'blocklist.set', reqId: sent.reqId, blockList: [a, b] });
    socket.receive({ type: 'blocklist.ack', reqId: sent.reqId });
    await expect(adding).resolves.toEqual([a, b]);
    await expect(client.getBlockList(GID)).resolves.toEqual([a, b]);

    const removing = client.removeFromBlockList(GID, [a]);
    await settle();
    expect(socket.lastMessage()).toMatchObject({ type: 'blocklist.set', blockList: [b] });
    socket.receive({ type: 'blocklist.ack', reqId: socket.lastMessage().reqId });
    await expect(removing).resolves.toEqual([b]);
    client.close();
  });

  it('only stores the list for a group that is not live; it goes with the next resume', async () => {
    const { client, socket, storage } = await liveLeader();
    const sentBefore = socket.sent.length;
    const id = randomUUID();
    await expect(client.addToBlockList(OTHER, [id])).resolves.toEqual([id]);
    expect(socket.sent.length).toBe(sentBefore);
    expect(storedBlockList(storage, OTHER)).toEqual([id]);
    client.close();
  });

  it('refuses the 257th ID with BLOCK_LIST_FULL and changes nothing', async () => {
    const { client, socket } = await liveLeader();
    const many = Array.from({ length: 256 }, () => randomUUID());
    const filling = client.addToBlockList(GID, many);
    await settle();
    socket.receive({ type: 'blocklist.ack', reqId: socket.lastMessage().reqId });
    await filling;
    await expect(client.addToBlockList(GID, [randomUUID()])).rejects.toMatchObject({
      code: 'BLOCK_LIST_FULL',
      details: { limit: 256 },
    });
    await expect(client.getBlockList(GID)).resolves.toHaveLength(256);
    client.close();
  });

  it('needs a stored leader token and well-formed IDs', async () => {
    const { client } = await liveLeader();
    await expect(client.getBlockList(groupIdOf('M'))).rejects.toMatchObject({
      code: 'TOKEN_NOT_FOUND',
    });
    await expect(client.addToBlockList(groupIdOf('X'), [randomUUID()])).rejects.toMatchObject({
      code: 'TOKEN_NOT_FOUND',
    });
    await expect(client.addToBlockList(GID, ['not-an-id'])).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(client.addToBlockList(GID, 'x' as never)).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    client.close();
  });

  it('never puts IDs in errors or logs', async () => {
    const logs: string[] = [];
    const storage = memoryStorage();
    const { client } = await connectedClient({
      storage,
      logger: {
        debug: (event, fields) => logs.push(event + JSON.stringify(fields ?? {})),
        info: (event, fields) => logs.push(event + JSON.stringify(fields ?? {})),
        warn: (event, fields) => logs.push(event + JSON.stringify(fields ?? {})),
      },
    });
    const id = randomUUID();
    const error = await client.addToBlockList(GID, [id]).catch((e: unknown) => e);
    expect(JSON.stringify(error)).not.toContain(id);
    expect((error as Error).message).not.toContain(id);
    expect(logs.join('\n')).not.toContain(id);
    client.close();
  });
});
