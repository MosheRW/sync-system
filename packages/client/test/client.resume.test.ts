import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncClient } from '../src/client.js';
import { type TokenStorage, memoryStorage } from '../src/storage.js';
import { connectedClient } from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';
import { fakeToken, groupIdOf } from './helpers/tokens.js';

const KEY = 'sync-system:v1:app-a@127.0.0.1:1';
const GID = groupIdOf('G');

beforeEach(() => {
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function seed(
  storage: TokenStorage,
  entries: Array<{ token: string; recovery?: Record<string, unknown> }>,
): void {
  void storage.setItem(KEY, JSON.stringify({ v: 1, entries }));
}

function stored(storage: TokenStorage): string[] {
  const text = storage.getItem(KEY) as string | null;
  return text === null
    ? []
    : (JSON.parse(text) as { entries: Array<{ token: string }> }).entries.map((e) => e.token);
}

async function client(
  storage: TokenStorage,
): Promise<{ client: SyncClient; socket: FakeWebSocket }> {
  const result = await connectedClient({ storage });
  await settle();
  return result;
}

describe('resumeGroup (#5 AC38)', () => {
  it('resumes a leader with its saved recovery data, or overrides', async () => {
    const storage = memoryStorage();
    const token = fakeToken({ gid: GID });
    seed(storage, [
      { token, recovery: { metadata: { m: 1 }, hasPosition: true, position: 3, blockList: [] } },
    ]);
    const { client: c, socket } = await client(storage);
    const resuming = c.resumeGroup(GID, { position: 9 });
    await settle();
    const sent = socket.lastMessage();
    expect(sent).toEqual({
      type: 'group.resume',
      reqId: sent.reqId,
      token,
      metadata: { m: 1 },
      position: 9,
      blockList: [],
    });
    socket.receive({
      type: 'group.resumed',
      reqId: sent.reqId,
      groupId: GID,
      participantId: 'pid',
      role: 'leader',
      metadata: { m: 1 },
      hasPosition: true,
      position: 9,
      token: fakeToken({ gid: GID }),
      recreated: true,
    });
    await expect(resuming).resolves.toEqual({
      groupId: GID,
      role: 'leader',
      participantId: 'pid',
      status: 'active',
      recreated: true,
      leaderOnline: true,
      metadata: { m: 1 },
      hasPosition: true,
      position: 9,
    });
    expect(c.getSnapshot().group).toMatchObject({ status: 'active', role: 'leader' });
    c.close();
  });

  it('resumes a member: active, or waiting for its leader', async () => {
    const storage = memoryStorage();
    const token = fakeToken({ gid: GID, role: 'member' });
    seed(storage, [{ token }]);
    const { client: c, socket } = await client(storage);
    const resuming = c.resumeGroup(GID, { metadata: { ignored: true } });
    await settle();
    const sent = socket.lastMessage();
    expect(sent).toEqual({ type: 'group.resume', reqId: sent.reqId, token });
    socket.receive({ type: 'group.waiting', reqId: sent.reqId, groupId: GID });
    await expect(resuming).resolves.toMatchObject({ status: 'waiting', role: 'member' });
    expect(c.getSnapshot().group).toEqual({ status: 'waiting', groupId: GID, role: 'member' });
    c.close();
  });

  it('rejects TOKEN_NOT_FOUND when nothing is stored for the group', async () => {
    const { client: c, socket } = await client(memoryStorage());
    const sentBefore = socket.sent.length;
    await expect(c.resumeGroup(GID)).rejects.toMatchObject({ code: 'TOKEN_NOT_FOUND' });
    expect(socket.sent.length).toBe(sentBefore);
    c.close();
  });

  it('checks locally first', async () => {
    const { client: c, socket } = await client(memoryStorage());
    await expect(c.resumeGroup('')).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    await expect(c.resumeGroup(GID, { metadata: [] as never })).rejects.toMatchObject({
      code: 'INVALID_PAYLOAD',
    });
    await expect(c.resumeGroup(GID, { position: 'x'.repeat(5000) })).rejects.toMatchObject({
      code: 'MESSAGE_TOO_LARGE',
    });
    // In a group already.
    void c.createGroup({});
    socket.receive({
      type: 'group.created',
      reqId: socket.lastMessage().reqId,
      groupId: GID,
      participantId: 'p',
      role: 'leader',
      token: fakeToken({ gid: GID }),
    });
    await settle();
    await expect(c.resumeGroup(GID)).rejects.toMatchObject({ code: 'ALREADY_IN_GROUP' });
    c.close();
    await expect(c.resumeGroup(GID)).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('deletes the token when the server says it is dead', async () => {
    const storage = memoryStorage();
    seed(storage, [{ token: fakeToken({ gid: GID, role: 'member' }) }]);
    const { client: c, socket } = await client(storage);
    const resuming = c.resumeGroup(GID);
    await settle();
    socket.receive({
      type: 'error',
      reqId: socket.lastMessage().reqId,
      code: 'GROUP_ENDED',
      message: 'x',
    });
    await expect(resuming).rejects.toMatchObject({ code: 'GROUP_ENDED', source: 'server' });
    await settle();
    expect(stored(storage)).toEqual([]);
    c.close();
  });
});

describe('endGroup and leaveGroup (#5 AC29, AC30, AC31)', () => {
  async function leader() {
    const storage = memoryStorage();
    const { client: c, socket } = await client(storage);
    const creating = c.createGroup({});
    socket.receive({
      type: 'group.created',
      reqId: socket.lastMessage().reqId,
      groupId: GID,
      participantId: 'p',
      role: 'leader',
      token: fakeToken({ gid: GID }),
    });
    await creating;
    await settle();
    return { c, socket, storage };
  }

  async function member() {
    const storage = memoryStorage();
    const { client: c, socket } = await client(storage);
    const joining = c.joinGroup(GID);
    socket.receive({
      type: 'group.joined',
      reqId: socket.lastMessage().reqId,
      groupId: GID,
      participantId: 'p',
      role: 'member',
      metadata: {},
      token: fakeToken({ gid: GID, role: 'member' }),
      leaderOnline: true,
      hasPosition: false,
    });
    await joining;
    await settle();
    return { c, socket, storage };
  }

  it('endGroup sends group.end, then deletes the token and ends the group', async () => {
    const { c, socket, storage } = await leader();
    expect(stored(storage)).toHaveLength(1);
    const ending = c.endGroup();
    const sent = socket.lastMessage();
    expect(sent).toEqual({ type: 'group.end', reqId: sent.reqId });
    socket.receive({
      type: 'group.ended',
      reqId: sent.reqId,
      groupId: GID,
      reason: 'ended_by_leader',
    });
    await expect(ending).resolves.toBeUndefined();
    expect(c.getSnapshot().group).toEqual({
      status: 'ended',
      groupId: GID,
      reason: 'ended_by_leader',
    });
    await settle();
    expect(stored(storage)).toEqual([]);
    c.close();
  });

  it('leaveGroup sends group.leave, then deletes the token and ends with left', async () => {
    const { c, socket, storage } = await member();
    const leaving = c.leaveGroup();
    const sent = socket.lastMessage();
    expect(sent).toEqual({ type: 'group.leave', reqId: sent.reqId });
    socket.receive({ type: 'group.left', reqId: sent.reqId, groupId: GID });
    await leaving;
    expect(c.getSnapshot().group).toEqual({ status: 'ended', groupId: GID, reason: 'left' });
    await settle();
    expect(stored(storage)).toEqual([]);
    c.close();
  });

  it('checks roles and state locally', async () => {
    const lead = await leader();
    await expect(lead.c.leaveGroup()).rejects.toMatchObject({ code: 'LEADER_CANNOT_LEAVE' });
    lead.c.close();
    const mem = await member();
    await expect(mem.c.endGroup()).rejects.toMatchObject({
      code: 'NOT_LEADER',
      message: 'Only the leader can end the group',
    });
    mem.c.close();
    const { client: none } = await client(memoryStorage());
    await expect(none.endGroup()).rejects.toMatchObject({ code: 'NOT_IN_GROUP' });
    await expect(none.leaveGroup()).rejects.toMatchObject({ code: 'NOT_IN_GROUP' });
    none.close();
    await expect(none.leaveGroup()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('keeps the token when the request fails', async () => {
    const { c, socket, storage } = await member();
    const leaving = c.leaveGroup();
    socket.receive({
      type: 'error',
      reqId: socket.lastMessage().reqId,
      code: 'NOT_IN_GROUP',
      message: 'x',
    });
    await expect(leaving).rejects.toMatchObject({ code: 'NOT_IN_GROUP' });
    await settle();
    expect(stored(storage)).toHaveLength(1);
    c.close();
  });
});
