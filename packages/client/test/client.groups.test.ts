import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSyncClientError } from '../src/errors.js';
import type { GroupEndedInfo, PositionUpdatedEvent } from '../src/state.js';
import { PARTICIPANT_ID, connectedClient } from './helpers/client.js';
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
    });
    expect(client.getSnapshot().group).toEqual({
      status: 'active',
      groupId: GROUP_ID,
      role: 'leader',
      metadata: null,
      hasPosition: true,
      position: { page: 1 },
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

describe('joinGroup (AC16)', () => {
  it('resolves with metadata and the current position', async () => {
    const { client, socket } = await connectedClient();
    const joining = client.joinGroup(GROUP_ID);
    expect(socket.lastMessage()).toEqual({ type: 'group.join', reqId: 'c2', groupId: GROUP_ID });
    const metadata = { book: 'b1' };
    socket.receive({
      type: 'group.joined',
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
    const joining = client.joinGroup(GROUP_ID);
    socket.receive({
      type: 'group.joined',
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
    ['GROUP_NOT_FOUND', undefined],
    ['GROUP_FULL', { maxGroupSize: 2 }],
    ['ALREADY_IN_GROUP', undefined],
  ] as const)('rejects with %s', async (code, details) => {
    const { client, socket } = await connectedClient();
    const joining = client.joinGroup(GROUP_ID);
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

  it('rejects a group ID that is not a string of 1..256 characters, without sending', async () => {
    const { client, socket } = await connectedClient();
    const sentBefore = socket.sent.length;
    for (const bad of ['', 'x'.repeat(257), 5]) {
      const error = await rejection(client.joinGroup(bad as never));
      expect(isSyncClientError(error, 'INVALID_PAYLOAD')).toBe(true);
    }
    expect(socket.sent).toHaveLength(sentBefore);
    client.close();
  });
});

describe('group events (AC19, AC20)', () => {
  async function member() {
    const { client, socket } = await connectedClient();
    const joining = client.joinGroup(GROUP_ID);
    socket.receive({
      type: 'group.joined',
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
    socket.receive({ type: 'group.ended', groupId: 'H'.repeat(43), reason: 'leader_disconnected' });
    expect(listener).not.toHaveBeenCalled();
    client.close();
  });

  it('emits groupEnded on group.ended and marks the group ended', async () => {
    const { client, socket } = await member();
    const ended: GroupEndedInfo[] = [];
    client.on('groupEnded', (e) => ended.push(e));
    socket.receive({ type: 'group.ended', groupId: GROUP_ID, reason: 'leader_disconnected' });
    expect(ended).toEqual([{ groupId: GROUP_ID, reason: 'leader_disconnected' }]);
    expect(client.getSnapshot().group).toEqual({
      status: 'ended',
      groupId: GROUP_ID,
      reason: 'leader_disconnected',
    });
    // An ended group allows a new create or join.
    void client.joinGroup(GROUP_ID).catch(() => {});
    expect(socket.lastMessage().type).toBe('group.join');
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
