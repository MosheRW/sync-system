import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../src/storage.js';
import { indicatorOf } from '../src/state.js';
import { CREATED_FIELDS, TEST_CODES, connectedClient } from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';
import { fakeToken } from './helpers/tokens.js';

const GROUP_ID = 'G'.repeat(43);
const ME = '0b6a3f5e-8c1d-4e2f-9a7b-1c2d3e4f5a6b';
const OTHER = '1b6a3f5e-8c1d-4e2f-9a7b-1c2d3e4f5a6b';
const KEY = 'sync-system:v1:app-a@127.0.0.1:1';
const STATE = { blockList: [OTHER], locked: true, handoff: 'auto' } as const;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

function stored(storage: ReturnType<typeof memoryStorage>) {
  const text = storage.getItem(KEY) as string | null;
  return text === null
    ? []
    : (JSON.parse(text) as { entries: Array<Record<string, unknown>> }).entries;
}

async function member(storage = memoryStorage()) {
  const { client, socket } = await connectedClient({ storage });
  const joining = client.joinByCode('123456', { doorCode: '654321' });
  socket.receive({
    type: 'group.joined',
    reqId: socket.lastMessage().reqId,
    groupId: GROUP_ID,
    participantId: ME,
    role: 'member',
    metadata: { book: 'b' },
    token: fakeToken({ gid: GROUP_ID, pid: ME, role: 'member' }),
    leaderOnline: true,
    locked: false,
    displayName: 'Guest 2',
    generated: true,
    hasPosition: true,
    position: { page: 4 },
  });
  await joining;
  return { client, socket, storage };
}

function granted(
  reason: 'handoff_disconnect' | 'handoff_inactivity' | 'take_back',
  reqId?: string,
) {
  return {
    type: 'leader.granted',
    ...(reqId === undefined ? {} : { reqId }),
    groupId: GROUP_ID,
    reason,
    token: fakeToken({ gid: GROUP_ID, pid: ME, role: 'leader' }),
    state: STATE,
    joinMethods: CREATED_FIELDS.joinMethods,
    codes: TEST_CODES,
  };
}

describe('pause and grace for a member (#13 AC28, D8, D12)', () => {
  it('maps leader.offline with a grace to leader_grace and a local deadline', async () => {
    const { client, socket } = await member();
    socket.receive({
      type: 'leader.offline',
      groupId: GROUP_ID,
      cause: 'inactive',
      graceMs: 30_000,
    });
    expect(client.getSnapshot().group).toMatchObject({
      leaderOnline: false,
      leader: { status: 'inactive', graceEndsAt: Date.now() + 30_000 },
    });
    expect(indicatorOf(client.getSnapshot())).toBe('leader_grace');
    socket.receive({ type: 'leader.offline', groupId: GROUP_ID, cause: 'disconnected' });
    expect(indicatorOf(client.getSnapshot())).toBe('leader_offline');
    socket.receive({ type: 'leader.online', groupId: GROUP_ID });
    expect(client.getSnapshot().group).toMatchObject({ leader: { status: 'online' } });
    expect(indicatorOf(client.getSnapshot())).toBe('following');
    client.close();
  });
});

describe('leadership changes (#13 AC23, AC24, RC12)', () => {
  it('nowLeading: stores the leader token with recovery and leads', async () => {
    const { client, socket, storage } = await member();
    const events: unknown[] = [];
    client.on('nowLeading', (e) => events.push(e));
    socket.receive(granted('handoff_disconnect'));
    expect(events).toEqual([{ groupId: GROUP_ID, reason: 'handoff_disconnect' }]);
    expect(client.getSnapshot().group).toMatchObject({ role: 'leader', locked: true });
    expect(client.getLeaderState()).toEqual(STATE);
    expect(client.getJoinCodes()).toMatchObject({ generation: TEST_CODES.generation });
    await vi.waitFor(() =>
      expect(stored(storage)[0]?.recovery).toMatchObject({
        metadata: { book: 'b' },
        position: { page: 4 },
        blockList: [OTHER],
        locked: true,
        handoff: 'auto',
        joinCodes: TEST_CODES.blob,
      }),
    );
    client.close();
  });

  it('leadershipLost drops every leader-only datum from memory and storage (RC12)', async () => {
    const { client, socket, storage } = await member();
    socket.receive(granted('handoff_disconnect'));
    socket.receive({
      type: 'roster.snapshot',
      groupId: GROUP_ID,
      participants: [
        {
          participantId: OTHER,
          displayName: 'Noa',
          generated: false,
          role: 'member',
          connected: true,
          joinedAgoMs: 0,
        },
      ],
    });
    expect(client.getRoster()).toHaveLength(1);
    const lost: unknown[] = [];
    client.on('leadershipLost', (e) => lost.push(e));
    socket.receive({
      type: 'leader.lost',
      groupId: GROUP_ID,
      reason: 'take_back',
      token: fakeToken({ gid: GROUP_ID, pid: ME, role: 'member' }),
      takeBackAvailable: true,
    });
    expect(lost).toEqual([{ groupId: GROUP_ID, reason: 'take_back', takeBackAvailable: true }]);
    expect(client.getRoster()).toEqual([]);
    expect(client.getLeaderState()).toBeNull();
    expect(client.getJoinCodes()).toBeNull();
    expect(client.getSnapshot().group).toMatchObject({ role: 'member', takeBackAvailable: true });
    await vi.waitFor(() => expect(stored(storage)[0]).not.toHaveProperty('recovery'));
    client.close();
  });

  it('take-back: offered, then requested, resolves when leading again', async () => {
    const { client, socket } = await member();
    const offered: unknown[] = [];
    client.on('takeBackOffered', (e) => offered.push(e));
    socket.receive({ type: 'takeback.offered', groupId: GROUP_ID });
    expect(offered).toEqual([{ groupId: GROUP_ID }]);
    expect(client.getSnapshot().group).toMatchObject({ takeBackAvailable: true });
    const taking = client.takeBackLeadership();
    expect(socket.lastMessage()).toMatchObject({ type: 'leader.takeBack' });
    socket.receive(granted('take_back', socket.lastMessage().reqId as string));
    await taking;
    expect(client.getSnapshot().group).toMatchObject({ role: 'leader', takeBackAvailable: false });
    client.close();
  });

  it('leaderChanged carries no ID', async () => {
    const { client, socket } = await member();
    const changed: unknown[] = [];
    client.on('leaderChanged', (e) => changed.push(e));
    socket.receive({ type: 'leader.changed', groupId: GROUP_ID, reason: 'superseded' });
    expect(changed).toEqual([{ groupId: GROUP_ID, reason: 'superseded' }]);
    client.close();
  });
});

describe('keep-alive for the leader (#13 AC16, AC42)', () => {
  it('emits keepAlive with a local deadline, answers it, and keepAliveCleared', async () => {
    const { client, socket } = await member();
    socket.receive(granted('handoff_disconnect'));
    const prompts: unknown[] = [];
    const cleared: unknown[] = [];
    client.on('keepAlive', (e) => prompts.push(e));
    client.on('keepAliveCleared', (e) => cleared.push(e));
    socket.receive({ type: 'keepalive.prompt', groupId: GROUP_ID, countdownMs: 60_000 });
    expect(prompts).toEqual([
      { groupId: GROUP_ID, countdownMs: 60_000, deadlineAt: Date.now() + 60_000 },
    ]);
    const answering = client.answerKeepAlive();
    expect(socket.lastMessage()).toMatchObject({ type: 'keepalive.ack' });
    socket.receive({ type: 'activity.ack', reqId: socket.lastMessage().reqId });
    await answering;
    socket.receive({ type: 'keepalive.cleared', groupId: GROUP_ID });
    expect(cleared).toEqual([{ groupId: GROUP_ID }]);
    client.close();
  });
});
