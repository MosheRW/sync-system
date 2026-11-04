import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSyncClientError } from '../src/errors.js';
import type { GroupEndedInfo, PositionUpdatedEvent } from '../src/state.js';
import {
  TEST_CODES,
  joinFrame,
  CREATED_FIELDS,
  PARTICIPANT_ID,
  connectedClient,
  joinTestGroup,
} from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';

const GROUP_ID = 'G'.repeat(43);

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

describe('createGroup (AC15)', () => {
  it('sends group.create and resolves on group.created as leader', async () => {
    const { client, socket } = await connectedClient();
    const metadata = { book: 'b1', extra: { nested: [1] } };
    const creating = client.createGroup(metadata, { page: 1 });
    const sent = socket.lastMessage();
    expect(sent).toEqual({ type: 'group.create', reqId: 'c2', metadata, position: { page: 1 } });
    socket.receive({
      type: 'group.created',
      handoff: 'auto',
      displayName: 'Guest 1',
      generated: true,
      state: { blockList: [], locked: false, handoff: 'auto' },
      ...CREATED_FIELDS,
      token: 'h.p.s',
      reqId: 'c2',
      groupId: GROUP_ID,
      participantId: PARTICIPANT_ID,
      role: 'leader',
    });
    await expect(creating).resolves.toEqual({
      groupId: GROUP_ID,
      role: 'leader',
      participantId: PARTICIPANT_ID,
      joinMethods: ['A', 'D'],
      codes: { generation: TEST_CODES.generation, groupCode: '123456', doorCode: '654321' },
    });
    expect(client.getSnapshot().group).toEqual({
      status: 'active',
      groupId: GROUP_ID,
      role: 'leader',
      metadata,
      hasPosition: true,
      position: { page: 1 },
      leaderOnline: true,
    });
    client.close();
  });

  it('omits the position when none is given', async () => {
    const { client, socket } = await connectedClient();
    void client.createGroup({}).catch(() => {});
    expect(socket.lastMessage()).toEqual({ type: 'group.create', reqId: 'c2', metadata: {} });
    client.close();
  });

  it('rejects with the server error code and typed details', async () => {
    const { client, socket } = await connectedClient();
    const creating = client.createGroup({ a: 1 });
    socket.receive({
      type: 'error',
      reqId: 'c2',
      code: 'MESSAGE_TOO_LARGE',
      message: 'x',
      details: { field: 'metadata', limitBytes: 10 },
    });
    const error = await rejection(creating);
    expect(isSyncClientError(error, 'MESSAGE_TOO_LARGE')).toBe(true);
    if (!isSyncClientError(error, 'MESSAGE_TOO_LARGE')) return;
    expect(error.source).toBe('server');
    expect(error.request).toBe('group.create');
    expect(error.details).toEqual({ field: 'metadata', limitBytes: 10 });
    expect(client.getSnapshot().group).toBeNull();
    client.close();
  });

  it('rejects a metadata value that is not an object', async () => {
    const { client, socket } = await connectedClient();
    const sentBefore = socket.sent.length;
    for (const bad of [null, [1], 'x', 5]) {
      const error = await rejection(client.createGroup(bad as never));
      expect(isSyncClientError(error, 'INVALID_PAYLOAD')).toBe(true);
    }
    expect(socket.sent).toHaveLength(sentBefore);
    client.close();
  });
});

describe('join by group ID is gone (#10 AC41)', () => {
  it('has no joinGroup method', async () => {
    const { client } = await connectedClient();
    // @ts-expect-error joinGroup was removed in #10.
    expect(client.joinGroup).toBeUndefined();
    client.close();
  });
});

describe('joinByCode (AC16, #10 AC39)', () => {
  it('resolves with metadata and the current position', async () => {
    const { client, socket } = await connectedClient();
    const joining = joinTestGroup(client);
    expect(socket.lastMessage()).toEqual(joinFrame('c2'));
    const metadata = { book: 'b1' };
    socket.receive({
      type: 'group.joined',
      displayName: 'Guest 1',
      generated: true,
      locked: false,
      token: 'h.p.s',
      leaderOnline: true,
      reqId: 'c2',
      groupId: GROUP_ID,
      participantId: PARTICIPANT_ID,
      role: 'member',
      metadata,
      hasPosition: true,
      position: { page: 7 },
    });
    const joined = await joining;
    expect(joined).toEqual({
      groupId: GROUP_ID,
      role: 'member',
      participantId: PARTICIPANT_ID,
      metadata,
      hasPosition: true,
      position: { page: 7 },
    });
    expect(client.getSnapshot().group).toMatchObject({
      status: 'active',
      role: 'member',
      metadata,
      hasPosition: true,
      position: { page: 7 },
    });
    client.close();
  });

  it('reports "no position yet" explicitly', async () => {
    const { client, socket } = await connectedClient();
    const joining = joinTestGroup(client);
    socket.receive({
      type: 'group.joined',
      displayName: 'Guest 1',
      generated: true,
      locked: false,
      token: 'h.p.s',
      leaderOnline: true,
      reqId: 'c2',
      groupId: GROUP_ID,
      participantId: PARTICIPANT_ID,
      role: 'member',
      metadata: {},
      hasPosition: false,
    });
    const joined = await joining;
    expect(joined.hasPosition).toBe(false);
    expect('position' in joined).toBe(false);
    client.close();
  });

  it.each([
    ['CODE_NOT_FOUND', undefined],
    ['GROUP_FULL', { maxGroupSize: 2 }],
    ['ALREADY_IN_GROUP', undefined],
  ] as const)('rejects with %s', async (code, details) => {
    const { client, socket } = await connectedClient();
    const joining = joinTestGroup(client);
    socket.receive({
      type: 'error',
      reqId: 'c2',
      code,
      message: 'x',
      ...(details ? { details } : {}),
    });
    const error = await rejection(joining);
    expect(isSyncClientError(error, code)).toBe(true);
    if (details && isSyncClientError(error)) expect(error.details).toEqual(details);
    client.close();
  });

  it('rejects a code that is not 6 digits or 8 alphabet characters, without sending', async () => {
    const { client, socket } = await connectedClient();
    const sentBefore = socket.sent.length;
    for (const bad of ['', '12345', 'x'.repeat(257), 5]) {
      const error = await rejection(client.joinByCode(bad as never));
      expect(isSyncClientError(error, 'INVALID_JOIN_CODE')).toBe(true);
    }
    expect(socket.sent).toHaveLength(sentBefore);
    client.close();
  });
});

describe('group events (AC19, AC20)', () => {
  async function member() {
    const { client, socket } = await connectedClient();
    const joining = joinTestGroup(client);
    socket.receive({
      type: 'group.joined',
      displayName: 'Guest 1',
      generated: true,
      locked: false,
      token: 'h.p.s',
      leaderOnline: true,
      reqId: 'c2',
      groupId: GROUP_ID,
      participantId: PARTICIPANT_ID,
      role: 'member',
      metadata: {},
      hasPosition: false,
    });
    await joining;
    return { client, socket };
  }

  it('emits positionUpdated with the payload untouched and updates the snapshot', async () => {
    const { client, socket } = await member();
    const events: PositionUpdatedEvent[] = [];
    client.on('positionUpdated', (e) => events.push(e));
    const position = { page: 3, extra: { deep: [null, 'é', { x: 1 }] } };
    socket.receive({ type: 'position.updated', groupId: GROUP_ID, position });
    expect(events).toEqual([{ groupId: GROUP_ID, position }]);
    expect(client.getSnapshot().group).toMatchObject({ hasPosition: true, position });
    client.close();
  });

  it('ignores position.updated and group.ended for another group', async () => {
    const { client, socket } = await member();
    const listener = vi.fn();
    client.on('positionUpdated', listener);
    client.on('groupEnded', listener);
    socket.receive({ type: 'position.updated', groupId: 'H'.repeat(43), position: 1 });
    socket.receive({ type: 'group.ended', groupId: 'H'.repeat(43), reason: 'ended_by_leader' });
    expect(listener).not.toHaveBeenCalled();
    client.close();
  });

  it('emits groupEnded on group.ended and marks the group ended', async () => {
    const { client, socket } = await member();
    const ended: GroupEndedInfo[] = [];
    client.on('groupEnded', (e) => ended.push(e));
    socket.receive({ type: 'group.ended', groupId: GROUP_ID, reason: 'ended_by_leader' });
    expect(ended).toEqual([{ groupId: GROUP_ID, reason: 'ended_by_leader' }]);
    expect(client.getSnapshot().group).toEqual({
      status: 'ended',
      groupId: GROUP_ID,
      reason: 'ended_by_leader',
    });
    // An ended group allows a new create or join.
    void joinTestGroup(client).catch(() => {});
    expect(socket.lastMessage().type).toBe('group.joinByCode');
    client.close();
  });

  it('close() ends an active group and emits groupEnded', async () => {
    const { client } = await member();
    const ended = vi.fn();
    client.on('groupEnded', ended);
    client.close();
    expect(ended).toHaveBeenCalledWith({ groupId: GROUP_ID, reason: 'closed' });
    expect(client.getSnapshot().group).toMatchObject({ status: 'ended' });
  });
});
