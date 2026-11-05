import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSyncClientError } from '../src/errors.js';
import type { RosterChangedEvent } from '../src/state.js';
import { memoryStorage } from '../src/storage.js';
import { CREATED_FIELDS, connectedClient } from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';
import { fakeToken } from './helpers/tokens.js';

const GROUP_ID = 'G'.repeat(43);
const LEADER_PID = '0b6a3f5e-8c1d-4e2f-9a7b-1c2d3e4f5a6b';
const MEMBER_PID = '1b6a3f5e-8c1d-4e2f-9a7b-1c2d3e4f5a6b';
const STATE = { blockList: [], locked: false, handoff: 'frozen' } as const;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

async function leader(storage = memoryStorage()) {
  const { client, socket } = await connectedClient({ storage });
  const token = fakeToken({ gid: GROUP_ID, pid: LEADER_PID });
  const creating = client.createGroup({ m: 1 }, undefined, {
    handoff: 'frozen',
    displayName: ' Dana ',
  });
  socket.receive({
    type: 'group.created',
    handoff: 'frozen',
    displayName: 'Dana',
    generated: false,
    state: STATE,
    ...CREATED_FIELDS,
    reqId: socket.lastMessage().reqId,
    groupId: GROUP_ID,
    participantId: LEADER_PID,
    role: 'leader',
    token,
  });
  await creating;
  return { client, socket, storage, token };
}

function entry(pid: string, role: 'leader' | 'member', name: string) {
  return {
    participantId: pid,
    displayName: name,
    generated: false,
    role,
    connected: true,
    joinedAgoMs: 1_000,
  };
}

describe('names and handoff mode at creation (#13 AC3, AC35, AC36)', () => {
  it('sends the handoff mode and the name, and keeps the own name in the group state', async () => {
    const { client, socket } = await connectedClient();
    void client.createGroup({}, undefined, { handoff: 'auto', displayName: 'Noa' }).catch(() => {});
    expect(socket.lastMessage()).toMatchObject({
      type: 'group.create',
      handoff: 'auto',
      displayName: 'Noa',
    });
    client.close();
    const { client: led } = await leader();
    expect(led.getSnapshot().group).toMatchObject({
      displayName: 'Dana',
      generated: false,
      locked: false,
    });
    expect(led.getLeaderState()).toEqual(STATE);
    led.close();
  });

  it('refuses a bad name or handoff mode locally, sending nothing', async () => {
    const { client, socket } = await connectedClient();
    const sent = socket.sent.length;
    const bad = await rejection(client.createGroup({}, undefined, { displayName: 'a‮b' }));
    expect(isSyncClientError(bad, 'INVALID_DISPLAY_NAME')).toBe(true);
    const mode = await rejection(
      client.createGroup({}, undefined, { handoff: 'manual' as unknown as 'auto' }),
    );
    expect(isSyncClientError(mode, 'INVALID_OPTIONS')).toBe(true);
    expect(socket.sent.length).toBe(sent);
    client.close();
  });
});

describe('the leader-only roster (#13 AC31)', () => {
  it('applies snapshot, updates and removals, and emits rosterChanged', async () => {
    const { client, socket } = await leader();
    const events: RosterChangedEvent[] = [];
    client.on('rosterChanged', (e) => events.push(e));
    socket.receive({
      type: 'roster.snapshot',
      groupId: GROUP_ID,
      participants: [entry(LEADER_PID, 'leader', 'Dana')],
    });
    socket.receive({
      type: 'roster.updated',
      groupId: GROUP_ID,
      participant: entry(MEMBER_PID, 'member', 'Noa'),
    });
    expect(client.getRoster().map((e) => [e.participantId, e.role, e.displayName])).toEqual([
      [LEADER_PID, 'leader', 'Dana'],
      [MEMBER_PID, 'member', 'Noa'],
    ]);
    expect(client.getRoster()[1]?.joinedAt).toBe(Date.now() - 1_000);
    socket.receive({ type: 'roster.removed', groupId: GROUP_ID, participantId: MEMBER_PID });
    expect(client.getRoster()).toHaveLength(1);
    expect(events).toHaveLength(3);
    // Frames for another group are ignored.
    socket.receive({ type: 'roster.removed', groupId: 'X'.repeat(43), participantId: LEADER_PID });
    expect(events).toHaveLength(3);
    client.close();
    expect(client.getRoster()).toEqual([]);
    expect(client.getLeaderState()).toBeNull();
  });
});

describe('recovery state and the own name across resumes (#13 D13, Q5.4)', () => {
  it('stores the leader state and the name, and sends both on a resume', async () => {
    const storage = memoryStorage();
    const { client, socket } = await leader(storage);
    client.close();
    const { client: again, socket: next } = await connectedClient({ storage });
    void again.resumeGroup(GROUP_ID).catch(() => {});
    await vi.waitFor(() => expect(next.lastMessage().type).toBe('group.resume'));
    expect(next.lastMessage()).toMatchObject({
      locked: false,
      handoff: 'frozen',
      displayName: 'Dana',
      blockList: [],
    });
    again.close();
    void socket;
  });
});

describe('vice, lock and removal in the leader API (#13 AC10, AC29, AC32)', () => {
  it('sets and clears the vice, locks and unlocks, and keeps the state for recovery', async () => {
    const storage = memoryStorage();
    const { client, socket } = await leader(storage);
    const setting = client.setViceLeader(MEMBER_PID);
    expect(socket.lastMessage()).toMatchObject({ type: 'vice.set', participantId: MEMBER_PID });
    socket.receive({
      type: 'vice.updated',
      reqId: socket.lastMessage().reqId,
      groupId: GROUP_ID,
      viceId: MEMBER_PID,
    });
    await expect(setting).resolves.toBe(MEMBER_PID);
    expect(client.getLeaderState()).toMatchObject({ viceId: MEMBER_PID });
    const locking = client.lockGroup();
    socket.receive({
      type: 'lock.changed',
      reqId: socket.lastMessage().reqId,
      groupId: GROUP_ID,
      locked: true,
    });
    await locking;
    expect(client.getSnapshot().group).toMatchObject({ locked: true });
    const clearing = client.clearViceLeader();
    socket.receive({
      type: 'vice.updated',
      reqId: socket.lastMessage().reqId,
      groupId: GROUP_ID,
      viceId: null,
    });
    await clearing;
    expect(client.getLeaderState()).toEqual({ ...STATE, locked: true });
    client.close();
  });

  it('removeMember resolves with the block list and refuses a bad ID locally', async () => {
    const { client, socket } = await leader();
    const bad = await rejection(client.removeMember('nope'));
    expect(isSyncClientError(bad, 'INVALID_PAYLOAD')).toBe(true);
    const removing = client.removeMember(MEMBER_PID);
    socket.receive({
      type: 'member.removed',
      reqId: socket.lastMessage().reqId,
      groupId: GROUP_ID,
      participantId: MEMBER_PID,
      blockList: [MEMBER_PID],
    });
    await expect(removing).resolves.toEqual([MEMBER_PID]);
    expect(client.getLeaderState()?.blockList).toEqual([MEMBER_PID]);
    client.close();
  });

  it('a member hears lock and vice changes', async () => {
    const { client, socket } = await connectedClient();
    const joining = client.joinByCode('123456', { doorCode: '654321' });
    socket.receive({
      type: 'group.joined',
      reqId: socket.lastMessage().reqId,
      groupId: GROUP_ID,
      participantId: MEMBER_PID,
      role: 'member',
      metadata: {},
      token: fakeToken({ gid: GROUP_ID, pid: MEMBER_PID, role: 'member' }),
      leaderOnline: true,
      locked: false,
      displayName: 'Guest 2',
      generated: true,
      hasPosition: false,
    });
    await joining;
    const locks: unknown[] = [];
    const vices: unknown[] = [];
    client.on('lockChanged', (e) => locks.push(e));
    client.on('viceChanged', (e) => vices.push(e));
    socket.receive({ type: 'lock.changed', groupId: GROUP_ID, locked: true });
    socket.receive({ type: 'vice.changed', groupId: GROUP_ID, isVice: true });
    expect(locks).toEqual([{ groupId: GROUP_ID, locked: true }]);
    expect(vices).toEqual([{ groupId: GROUP_ID, isVice: true }]);
    expect(client.getSnapshot().group).toMatchObject({ locked: true });
    client.close();
  });
});

describe('removal closes the client for good (#13 Gate 2 Q-A)', () => {
  it('on close 4004: no reconnect, token deleted, closed(removed), removed event', async () => {
    const storage = memoryStorage();
    const { client, socket } = await connectedClient({ storage });
    const joining = client.joinByCode('123456', { doorCode: '654321' });
    socket.receive({
      type: 'group.joined',
      reqId: socket.lastMessage().reqId,
      groupId: GROUP_ID,
      participantId: MEMBER_PID,
      role: 'member',
      metadata: {},
      token: fakeToken({ gid: GROUP_ID, pid: MEMBER_PID, role: 'member' }),
      leaderOnline: true,
      locked: false,
      displayName: 'Guest 2',
      generated: true,
      hasPosition: false,
    });
    await joining;
    const removed: unknown[] = [];
    client.on('removed', (e) => removed.push(e));
    const sockets = FakeWebSocket.instances.length;
    socket.receive({ type: 'group.ended', groupId: GROUP_ID, reason: 'removed' });
    socket.serverClose(4004, 'removed');
    expect(removed).toEqual([{ groupId: GROUP_ID }]);
    expect(client.getState()).toMatchObject({ status: 'closed', reason: 'removed' });
    expect(client.getSnapshot().group).toMatchObject({ status: 'ended', reason: 'removed' });
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances.length).toBe(sockets);
    // The token is gone from storage.
    await vi.waitFor(() => {
      const text = storage.getItem('sync-system:v1:app-a@127.0.0.1:1') as string | null;
      const entries = text === null ? [] : (JSON.parse(text) as { entries: unknown[] }).entries;
      expect(entries).toEqual([]);
    });
  });

  it('classifies close 4004 as fatal', async () => {
    const { classifyClose } = await import('../src/handshake.js');
    expect(classifyClose(4004, false).error).toMatchObject({ code: 'REMOVED', fatal: true });
  });
});
