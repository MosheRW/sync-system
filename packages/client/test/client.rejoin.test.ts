import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncClient } from '../src/client.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../src/options.js';
import { type TokenStorage, memoryStorage } from '../src/storage.js';
import type { GroupEndedInfo, LeaderStatusEvent, ResumedGroup } from '../src/state.js';
import {
  TEST_CODES,
  RESUMED_FIELDS,
  CREATED_FIELDS,
  connectedClient,
  serverHandshake,
  joinTestGroup,
} from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';
import { fakeToken, groupIdOf } from './helpers/tokens.js';

const GROUP_ID = groupIdOf('G');
const KEY = 'sync-system:v1:app-a@127.0.0.1:1';
const METADATA = { book: 'b1' };
const BLOCKED = '0b6a3f5e-8c1d-4e2f-9a7b-1c2d3e4f5a6b';

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Lets storage promise chains run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

function storedTokens(storage: TokenStorage): string[] {
  const text = storage.getItem(KEY) as string | null;
  if (text === null) return [];
  return (JSON.parse(text) as { entries: Array<{ token: string }> }).entries.map((e) => e.token);
}

interface Setup {
  client: SyncClient;
  socket: FakeWebSocket;
  storage: TokenStorage;
  token: string;
}

async function member(storage: TokenStorage = memoryStorage()): Promise<Setup> {
  const { client, socket } = await connectedClient({ storage });
  const joining = joinTestGroup(client);
  const token = fakeToken({ gid: GROUP_ID, role: 'member' });
  socket.receive({
    type: 'group.joined',
    displayName: 'Guest 1',
    generated: true,
    reqId: socket.lastMessage().reqId,
    groupId: GROUP_ID,
    participantId: 'member-pid',
    role: 'member',
    metadata: METADATA,
    token,
    leaderOnline: true,
    hasPosition: true,
    position: { page: 1 },
  });
  await joining;
  await settle();
  return { client, socket, storage, token };
}

async function leader(storage: TokenStorage = memoryStorage()): Promise<Setup> {
  const { client, socket } = await connectedClient({ storage });
  const creating = client.createGroup(METADATA, { page: 1 });
  const token = fakeToken({ gid: GROUP_ID });
  socket.receive({
    type: 'group.created',
    handoff: 'auto',
    displayName: 'Guest 1',
    generated: true,
    ...CREATED_FIELDS,
    reqId: socket.lastMessage().reqId,
    groupId: GROUP_ID,
    participantId: 'leader-pid',
    role: 'leader',
    token,
  });
  await creating;
  await settle();
  return { client, socket, storage, token };
}

/** Drops `socket`, waits for the retry, completes the handshake, lets the resume go out. */
async function dropAndReconnect(client: SyncClient, socket: FakeWebSocket): Promise<FakeWebSocket> {
  socket.serverClose(1006);
  const state = client.getState();
  if (state.status !== 'reconnecting') throw new Error('expected reconnecting');
  vi.advanceTimersByTime(state.delayMs);
  const next = FakeWebSocket.last;
  serverHandshake(next, { participantId: 'participant-2' });
  await settle();
  return next;
}

describe('token rejoin after an unexpected drop (#5 AC35, AC36)', () => {
  it('keeps a member group as rejoining at the drop', async () => {
    const { client, socket } = await member();
    socket.serverClose(1006);
    expect(client.getSnapshot().group).toEqual({
      status: 'rejoining',
      groupId: GROUP_ID,
      role: 'member',
      metadata: METADATA,
      hasPosition: true,
      position: { page: 1 },
    });
    client.close();
  });

  it('keeps a leader group as rejoining too (no longer ended at the drop)', async () => {
    const { client, socket } = await leader();
    const ended = vi.fn();
    client.on('groupEnded', ended);
    socket.serverClose(1006);
    expect(client.getSnapshot().group).toMatchObject({
      status: 'rejoining',
      role: 'leader',
      metadata: METADATA,
      position: { page: 1 },
    });
    expect(ended).not.toHaveBeenCalled();
    client.close();
  });

  it('a member resumes with its token only and becomes active again', async () => {
    const { client, socket, storage, token } = await member();
    const rejoined: ResumedGroup[] = [];
    client.on('rejoined', (e) => rejoined.push(e));
    const next = await dropAndReconnect(client, socket);
    const resume = next.lastMessage();
    expect(resume).toEqual({ type: 'group.resume', reqId: resume.reqId, token });
    const fresh = fakeToken({ gid: GROUP_ID, role: 'member' });
    next.receive({
      type: 'group.joined',
      displayName: 'Guest 1',
      generated: true,
      reqId: resume.reqId,
      groupId: GROUP_ID,
      participantId: 'member-pid',
      role: 'member',
      metadata: METADATA,
      token: fresh,
      leaderOnline: false,
      hasPosition: true,
      position: { page: 4 },
    });
    expect(client.getSnapshot().group).toMatchObject({
      status: 'active',
      role: 'member',
      position: { page: 4 },
      leaderOnline: false,
    });
    expect(rejoined).toEqual([
      {
        groupId: GROUP_ID,
        role: 'member',
        participantId: 'member-pid',
        status: 'active',
        recreated: false,
        leaderOnline: false,
        metadata: METADATA,
        hasPosition: true,
        position: { page: 4 },
      },
    ]);
    await settle();
    expect(storedTokens(storage)).toEqual([fresh]);
    client.close();
  });

  it('a leader resumes with metadata, latest position and block list; the server position wins', async () => {
    const { client, socket, token } = await leader();
    client.updatePosition({ page: 7 });
    socket.receive({ type: 'position.ack', reqId: socket.lastMessage().reqId });
    const next = await dropAndReconnect(client, socket);
    const resume = next.lastMessage();
    expect(resume).toEqual({
      type: 'group.resume',
      reqId: resume.reqId,
      token,
      metadata: METADATA,
      position: { page: 7 },
      blockList: [],
      // The codes blob from group.created goes back with the resume (#10 AC32).
      joinCodes: TEST_CODES.blob,
    });
    next.receive({
      type: 'group.resumed',
      displayName: 'Guest 1',
      generated: true,
      reqId: resume.reqId,
      groupId: GROUP_ID,
      participantId: 'leader-pid',
      role: 'leader',
      metadata: METADATA,
      hasPosition: true,
      position: { page: 6 },
      token: fakeToken({ gid: GROUP_ID }),
      recreated: true,
      ...RESUMED_FIELDS,
    });
    expect(client.getSnapshot().group).toMatchObject({
      status: 'active',
      role: 'leader',
      position: { page: 6 },
    });
    // The throttle works again.
    client.updatePosition({ page: 8 });
    expect(next.lastMessage()).toMatchObject({ type: 'position.update', position: { page: 8 } });
    client.close();
  });

  it('reads the block list from storage, not a stale cache (L5)', async () => {
    const { client, socket, storage, token } = await leader();
    // Another tab blocked someone meanwhile.
    void storage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        entries: [
          {
            token,
            recovery: { metadata: METADATA, hasPosition: false, blockList: [BLOCKED] },
          },
        ],
      }),
    );
    const next = await dropAndReconnect(client, socket);
    expect(next.lastMessage()).toMatchObject({ blockList: [BLOCKED] });
    client.close();
  });

  it('waits when the server parks the member, then becomes active on admission', async () => {
    const { client, socket } = await member();
    const rejoined: ResumedGroup[] = [];
    client.on('rejoined', (e) => rejoined.push(e));
    const next = await dropAndReconnect(client, socket);
    next.receive({ type: 'group.waiting', reqId: next.lastMessage().reqId, groupId: GROUP_ID });
    expect(client.getSnapshot().group).toEqual({
      status: 'waiting',
      groupId: GROUP_ID,
      role: 'member',
    });
    expect(rejoined).toEqual([]);
    next.receive({
      type: 'group.joined',
      displayName: 'Guest 1',
      generated: true,
      groupId: GROUP_ID,
      participantId: 'member-pid',
      role: 'member',
      metadata: METADATA,
      token: fakeToken({ gid: GROUP_ID, role: 'member' }),
      leaderOnline: true,
      hasPosition: false,
    });
    expect(client.getSnapshot().group).toMatchObject({ status: 'active', leaderOnline: true });
    expect(rejoined).toMatchObject([{ status: 'active', recreated: true }]);
    client.close();
  });

  it('ends a waiting member on an unsolicited PARTICIPANT_BLOCKED and deletes the token', async () => {
    const { client, socket, storage } = await member();
    const next = await dropAndReconnect(client, socket);
    next.receive({ type: 'group.waiting', reqId: next.lastMessage().reqId, groupId: GROUP_ID });
    next.receive({ type: 'error', code: 'PARTICIPANT_BLOCKED', message: 'blocked' });
    expect(client.getSnapshot().group).toEqual({
      status: 'ended',
      groupId: GROUP_ID,
      reason: 'rejoin_failed',
      code: 'PARTICIPANT_BLOCKED',
    });
    await settle();
    expect(storedTokens(storage)).toEqual([]);
    client.close();
  });

  it('ends a waiting member on an unsolicited GROUP_FULL but keeps the token', async () => {
    const { client, socket, storage, token } = await member();
    const next = await dropAndReconnect(client, socket);
    next.receive({ type: 'group.waiting', reqId: next.lastMessage().reqId, groupId: GROUP_ID });
    next.receive({ type: 'error', code: 'GROUP_FULL', message: 'full' });
    expect(client.getSnapshot().group).toMatchObject({ status: 'ended', code: 'GROUP_FULL' });
    await settle();
    expect(storedTokens(storage)).toEqual([token]);
    client.close();
  });

  for (const code of ['TOKEN_INVALID', 'TOKEN_EXPIRED', 'GROUP_ENDED', 'PARTICIPANT_BLOCKED']) {
    it(`ends with rejoin_failed and deletes the token on ${code}`, async () => {
      const { client, socket, storage } = await member();
      const ended: GroupEndedInfo[] = [];
      client.on('groupEnded', (e) => ended.push(e));
      const next = await dropAndReconnect(client, socket);
      next.receive({ type: 'error', reqId: next.lastMessage().reqId, code, message: 'x' });
      expect(ended).toEqual([{ groupId: GROUP_ID, reason: 'rejoin_failed', code }]);
      await settle();
      expect(storedTokens(storage)).toEqual([]);
      client.close();
    });
  }

  it('keeps the token on GROUP_FULL', async () => {
    const { client, socket, storage, token } = await member();
    const next = await dropAndReconnect(client, socket);
    next.receive({
      type: 'error',
      reqId: next.lastMessage().reqId,
      code: 'GROUP_FULL',
      message: 'x',
    });
    expect(client.getSnapshot().group).toMatchObject({ status: 'ended', code: 'GROUP_FULL' });
    await settle();
    expect(storedTokens(storage)).toEqual([token]);
    client.close();
  });

  it('ends with TOKEN_NOT_FOUND when no token is stored', async () => {
    const { client, socket, storage } = await member();
    void storage.removeItem(KEY);
    const ended: GroupEndedInfo[] = [];
    client.on('groupEnded', (e) => ended.push(e));
    await dropAndReconnect(client, socket);
    expect(ended).toEqual([
      { groupId: GROUP_ID, reason: 'rejoin_failed', code: 'TOKEN_NOT_FOUND' },
    ]);
    client.close();
  });

  it('stays rejoining when the connection drops again before the answer, then retries', async () => {
    const { client, socket, token } = await member();
    const next = await dropAndReconnect(client, socket);
    expect(next.lastMessage()).toMatchObject({ type: 'group.resume' });
    const third = await dropAndReconnect(client, next);
    expect(client.getSnapshot().group).toMatchObject({ status: 'rejoining' });
    expect(third.lastMessage()).toMatchObject({ type: 'group.resume', token });
    client.close();
  });

  it('stays rejoining when the automatic resume times out, then retries', async () => {
    const { client, socket, token } = await member();
    const ended = vi.fn();
    client.on('groupEnded', ended);
    const next = await dropAndReconnect(client, socket);
    expect(next.lastMessage()).toMatchObject({ type: 'group.resume' });
    vi.advanceTimersByTime(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(ended).not.toHaveBeenCalled();
    expect(client.getSnapshot().group).toMatchObject({ status: 'rejoining', groupId: GROUP_ID });
    const state = client.getState();
    if (state.status !== 'reconnecting') throw new Error('expected reconnecting');
    vi.advanceTimersByTime(state.delayMs);
    const third = FakeWebSocket.last;
    serverHandshake(third, { participantId: 'participant-3' });
    await settle();
    expect(third.lastMessage()).toMatchObject({ type: 'group.resume', token });
    client.close();
  });

  it('never sends on a stale socket when close() happens during the storage read', async () => {
    const inner = memoryStorage();
    let release: () => void = () => undefined;
    let hold = false;
    const slow: TokenStorage = {
      getItem: (key) =>
        hold
          ? new Promise((resolve) => {
              release = () => resolve(inner.getItem(key));
            })
          : inner.getItem(key),
      setItem: (key, value) => inner.setItem(key, value),
      removeItem: (key) => inner.removeItem(key),
    };
    const { client, socket } = await member(slow);
    hold = true;
    const next = await dropAndReconnect(client, socket);
    const sentBefore = next.sent.length;
    client.close();
    release();
    await settle();
    release();
    await settle();
    expect(next.sent.length).toBe(sentBefore);
  });
});

describe('replaced and ended groups (#5 AC31, Q-C, L6)', () => {
  it('replaced: ends with reason replaced, keeps the token and never auto-resumes', async () => {
    const { client, socket, storage, token } = await member();
    const ended: GroupEndedInfo[] = [];
    client.on('groupEnded', (e) => ended.push(e));
    socket.receive({ type: 'group.ended', groupId: GROUP_ID, reason: 'replaced' });
    expect(ended).toEqual([{ groupId: GROUP_ID, reason: 'replaced' }]);
    await settle();
    expect(storedTokens(storage)).toEqual([token]);
    const next = await dropAndReconnect(client, socket);
    expect(next.messages.filter((m) => m.type === 'group.resume')).toEqual([]);
    client.close();
  });

  for (const reason of ['ended_by_leader', 'leader_timeout', 'max_session', 'removed']) {
    it(`${reason}: ends with that reason and deletes the token`, async () => {
      const { client, socket, storage } = await member();
      socket.receive({ type: 'group.ended', groupId: GROUP_ID, reason });
      expect(client.getSnapshot().group).toEqual({ status: 'ended', groupId: GROUP_ID, reason });
      await settle();
      expect(storedTokens(storage)).toEqual([]);
      client.close();
    });
  }
});

describe('leader status (#5 AC36)', () => {
  it('toggles leaderOnline and emits leaderStatus', async () => {
    const { client, socket } = await member();
    const events: LeaderStatusEvent[] = [];
    client.on('leaderStatus', (e) => events.push(e));
    socket.receive({ type: 'leader.offline', groupId: GROUP_ID });
    expect(client.getSnapshot().group).toMatchObject({ status: 'active', leaderOnline: false });
    socket.receive({ type: 'leader.offline', groupId: GROUP_ID });
    socket.receive({ type: 'leader.online', groupId: groupIdOf('H') });
    socket.receive({ type: 'leader.online', groupId: GROUP_ID });
    expect(client.getSnapshot().group).toMatchObject({ leaderOnline: true });
    expect(events).toEqual([
      { groupId: GROUP_ID, online: false },
      { groupId: GROUP_ID, online: true },
    ]);
    client.close();
  });
});
