import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncClient } from '../src/client.js';
import { memoryStorage } from '../src/storage.js';
import { CREATED_FIELDS, TEST_CODES, connectedClient, serverHandshake } from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';
import { fakeToken, groupIdOf } from './helpers/tokens.js';

/**
 * Every way a client stops leading drops all leader-only data (#13 RC12,
 * security L-3) and ends the private preview (#13 AC41):
 * leadership lost, demoted on a resume, removed (4004), group ended.
 */

const GROUP_ID = groupIdOf('G');
const OTHER_GROUP = groupIdOf('H');
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

/** A leader previewing `{page: 9}` with a pending join request. */
async function previewingLeader() {
  const { client, socket } = await connectedClient({ storage: memoryStorage() });
  await create(client, socket);
  socket.receive({
    type: 'join.requested',
    groupId: GROUP_ID,
    requestId: REQUEST_ID,
    expiresInMs: 60_000,
  });
  client.preview.start({ page: 9 });
  expect(client.preview.getState()).toMatchObject({ active: true, previewPosition: { page: 9 } });
  expect(client.getJoinRequests()).toHaveLength(1);
  expect(client.getJoinCodes()).not.toBeNull();
  return { client, socket };
}

/** Nothing of the lead is left. */
function expectNoLeaderData(client: SyncClient): void {
  expect(client.preview.getState()).toMatchObject({ active: false, previewPosition: undefined });
  expect(client.getJoinRequests()).toEqual([]);
  expect(client.getJoinCodes()).toBeNull();
  expect(client.getLeaderState()).toBeNull();
  expect(client.getRoster()).toEqual([]);
}

function positionUpdates(socket: FakeWebSocket) {
  return socket.messages.filter((m) => m.type === 'position.update');
}

describe('leader-only data and the preview on every demotion (#13 RC12, AC41)', () => {
  it('leadership lost: dropped, and bringGroupHere after a new grant moves nothing', async () => {
    const { client, socket } = await previewingLeader();
    socket.receive({
      type: 'leader.lost',
      groupId: GROUP_ID,
      reason: 'handoff_inactivity',
      token: fakeToken({ gid: GROUP_ID, pid: ME, role: 'member' }),
      takeBackAvailable: false,
    });
    expectNoLeaderData(client);
    // Granted the lead again: the old preview does not come back.
    socket.receive({
      type: 'leader.granted',
      groupId: GROUP_ID,
      reason: 'handoff_disconnect',
      token: fakeToken({ gid: GROUP_ID, pid: ME, role: 'leader' }),
      state: STATE,
      joinMethods: CREATED_FIELDS.joinMethods,
      codes: TEST_CODES,
    });
    const before = positionUpdates(socket).length;
    client.preview.bringGroupHere();
    vi.advanceTimersByTime(1_000);
    expect(positionUpdates(socket)).toHaveLength(before);
    client.close();
  });

  it('demoted on a resume (group.joined for a leader token): dropped', async () => {
    const { client, socket } = await previewingLeader();
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
    const { client, socket } = await previewingLeader();
    // Demoted first (a leader cannot be removed), still previewing as a member.
    socket.receive({
      type: 'leader.lost',
      groupId: GROUP_ID,
      reason: 'take_back',
      token: fakeToken({ gid: GROUP_ID, pid: ME, role: 'member' }),
      takeBackAvailable: true,
    });
    client.preview.start({ page: 7 });
    socket.receive({ type: 'group.ended', groupId: GROUP_ID, reason: 'removed' });
    socket.serverClose(4004, 'removed');
    expect(client.getState()).toMatchObject({ status: 'closed', reason: 'removed' });
    expectNoLeaderData(client);
  });

  it('group ended: dropped, and the next group is never moved to the old preview', async () => {
    const { client, socket } = await previewingLeader();
    socket.receive({ type: 'group.ended', groupId: GROUP_ID, reason: 'max_session' });
    expect(client.getSnapshot().group).toMatchObject({ status: 'ended' });
    expectNoLeaderData(client);
    await create(client, socket, OTHER_GROUP);
    const before = positionUpdates(socket).length;
    client.preview.bringGroupHere();
    vi.advanceTimersByTime(1_000);
    expect(positionUpdates(socket)).toHaveLength(before);
    expect(client.getJoinRequests()).toEqual([]);
    client.close();
  });

  it('a preview stays across the leader’s own reconnect to the same group', async () => {
    const { client, socket } = await previewingLeader();
    socket.serverClose(1006);
    const state = client.getState();
    if (state.status !== 'reconnecting') throw new Error('expected reconnecting');
    vi.advanceTimersByTime(state.delayMs);
    const next = FakeWebSocket.last;
    serverHandshake(next, { participantId: 'participant-2' });
    await settle();
    const resume = next.lastMessage();
    next.receive({
      type: 'group.resumed',
      reqId: resume.reqId,
      groupId: GROUP_ID,
      participantId: ME,
      role: 'leader',
      displayName: 'Guest 1',
      generated: true,
      metadata: { book: 'b' },
      token: fakeToken({ gid: GROUP_ID, pid: ME }),
      recreated: false,
      superseded: false,
      state: STATE,
      ...CREATED_FIELDS,
      codesChanged: false,
      hasPosition: true,
      position: { page: 1 },
    });
    await settle();
    expect(client.getSnapshot().group).toMatchObject({ status: 'active', role: 'leader' });
    expect(client.preview.getState()).toMatchObject({ active: true, previewPosition: { page: 9 } });
    client.close();
  });
});
