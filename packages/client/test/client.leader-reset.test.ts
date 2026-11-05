import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncClient } from '../src/client.js';
import { memoryStorage } from '../src/storage.js';
import { CREATED_FIELDS, connectedClient, serverHandshake } from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';
import { fakeToken, groupIdOf } from './helpers/tokens.js';

/**
 * Every way a client stops leading drops all leader-only data (#13 RC12,
 * security L-3): leadership lost, demoted on a resume, removed (4004),
 * group ended.
 */

const GROUP_ID = groupIdOf('G');
const ME = '0b6a3f5e-8c1d-4e2f-9a7b-1c2d3e4f5a6b';
const REQUEST_ID = 'R'.repeat(22);
const STATE = { blockList: [], locked: false, handoff: 'auto' } as const;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** Creates `groupId` as its leader on `socket`, at position `{page: 1}`. */
async function create(client: SyncClient, socket: FakeWebSocket, groupId = GROUP_ID) {
  const creating = client.createGroup({ book: 'b' }, { page: 1 });
  socket.receive({
    type: 'group.created',
    handoff: 'auto',
    displayName: 'Guest 1',
    generated: true,
    state: STATE,
    ...CREATED_FIELDS,
    reqId: socket.lastMessage().reqId,
    groupId,
    participantId: ME,
    role: 'leader',
    token: fakeToken({ gid: groupId, pid: ME }),
  });
  await creating;
  await settle();
}

/** A leader with codes and a pending join request. */
async function leaderWithRequests() {
  const { client, socket } = await connectedClient({ storage: memoryStorage() });
  await create(client, socket);
  socket.receive({
    type: 'join.requested',
    groupId: GROUP_ID,
    requestId: REQUEST_ID,
    expiresInMs: 60_000,
  });
  expect(client.getJoinRequests()).toHaveLength(1);
  expect(client.getJoinCodes()).not.toBeNull();
  return { client, socket };
}

/** Nothing of the lead is left. */
function expectNoLeaderData(client: SyncClient): void {
  expect(client.getJoinRequests()).toEqual([]);
  expect(client.getJoinCodes()).toBeNull();
  expect(client.getLeaderState()).toBeNull();
  expect(client.getRoster()).toEqual([]);
}

describe('leader-only data on every demotion (#13 RC12, security L-3)', () => {
  it('leadership lost: dropped', async () => {
    const { client, socket } = await leaderWithRequests();
    socket.receive({
      type: 'leader.lost',
      groupId: GROUP_ID,
      reason: 'handoff_inactivity',
      token: fakeToken({ gid: GROUP_ID, pid: ME, role: 'member' }),
      takeBackAvailable: false,
    });
    expectNoLeaderData(client);
    client.close();
  });

  it('demoted on a resume (group.joined for a leader token): dropped', async () => {
    const { client, socket } = await leaderWithRequests();
    socket.serverClose(1006);
    const state = client.getState();
    if (state.status !== 'reconnecting') throw new Error('expected reconnecting');
    vi.advanceTimersByTime(state.delayMs);
    const next = FakeWebSocket.last;
    serverHandshake(next, { participantId: 'participant-2' });
    await settle();
    const resume = next.lastMessage();
    expect(resume).toMatchObject({ type: 'group.resume' });
    next.receive({
      type: 'group.joined',
      reqId: resume.reqId,
      groupId: GROUP_ID,
      participantId: ME,
      role: 'member',
      metadata: { book: 'b' },
      token: fakeToken({ gid: GROUP_ID, pid: ME, role: 'member' }),
      leaderOnline: true,
      locked: false,
      displayName: 'Guest 1',
      generated: true,
      hasPosition: true,
      position: { page: 1 },
    });
    await settle();
    expect(client.getSnapshot().group).toMatchObject({ status: 'active', role: 'member' });
    expectNoLeaderData(client);
    client.close();
  });

  it('removed (close 4004): dropped', async () => {
    const { client, socket } = await leaderWithRequests();
    // Demoted first (a leader cannot be removed).
    socket.receive({
      type: 'leader.lost',
      groupId: GROUP_ID,
      reason: 'take_back',
      token: fakeToken({ gid: GROUP_ID, pid: ME, role: 'member' }),
      takeBackAvailable: true,
    });
    socket.receive({ type: 'group.ended', groupId: GROUP_ID, reason: 'removed' });
    socket.serverClose(4004, 'removed');
    expect(client.getState()).toMatchObject({ status: 'closed', reason: 'removed' });
    expectNoLeaderData(client);
  });

  it('group ended: dropped', async () => {
    const { client, socket } = await leaderWithRequests();
    socket.receive({ type: 'group.ended', groupId: GROUP_ID, reason: 'max_session' });
    expect(client.getSnapshot().group).toMatchObject({ status: 'ended' });
    expectNoLeaderData(client);
    client.close();
  });
});
