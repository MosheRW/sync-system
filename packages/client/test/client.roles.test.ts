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
