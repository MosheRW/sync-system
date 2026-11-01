import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncClient } from '../src/client.js';
import { isSyncClientError } from '../src/errors.js';
import type { SyncClientOptions } from '../src/options.js';
import type { GroupEndedInfo, JoinedGroup } from '../src/state.js';
import { PARTICIPANT_ID, connectedClient, serverHandshake } from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';

const GROUP_ID = 'G'.repeat(43);
const METADATA = { book: 'b1' };

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function member(
  extra: Partial<SyncClientOptions> = {},
): Promise<{ client: SyncClient; socket: FakeWebSocket }> {
  const { client, socket } = await connectedClient(extra);
  const joining = client.joinGroup(GROUP_ID);
  socket.receive({
    type: 'group.joined',
    token: 'h.p.s',
    leaderOnline: true,
    reqId: socket.lastMessage().reqId,
    groupId: GROUP_ID,
    participantId: PARTICIPANT_ID,
    role: 'member',
    metadata: METADATA,
    hasPosition: true,
    position: { page: 1 },
  });
  await joining;
  return { client, socket };
}

/** Drops `socket`, waits for the retry, and completes the handshake on the new socket. */
function dropAndReconnect(client: SyncClient, socket: FakeWebSocket): FakeWebSocket {
  socket.serverClose(1006);
  const state = client.getState();
  if (state.status !== 'reconnecting') throw new Error('expected reconnecting');
  vi.advanceTimersByTime(state.delayMs);
  const next = FakeWebSocket.last;
  serverHandshake(next, { participantId: 'participant-2' });
  return next;
}

describe('member rejoin after reconnect (Q1, AC29)', () => {
  it('keeps the group as rejoining at the drop, with the last metadata and position', async () => {
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

  it('re-sends group.join after hello.ok and emits rejoined with the current position', async () => {
    const { client, socket } = await member();
    const rejoined: JoinedGroup[] = [];
    client.on('rejoined', (e) => rejoined.push(e));
    const next = dropAndReconnect(client, socket);
    const join = next.lastMessage();
    expect(join).toMatchObject({ type: 'group.join', groupId: GROUP_ID });
    next.receive({
      type: 'group.joined',
      token: 'h.p.s',
      leaderOnline: true,
      reqId: join.reqId,
      groupId: GROUP_ID,
      participantId: 'participant-2',
      role: 'member',
      metadata: METADATA,
      hasPosition: true,
      position: { page: 5 },
    });
    expect(rejoined).toEqual([
      {
        groupId: GROUP_ID,
        role: 'member',
        participantId: 'participant-2',
        metadata: METADATA,
        hasPosition: true,
        position: { page: 5 },
      },
    ]);
    expect(client.getSnapshot().group).toMatchObject({ status: 'active', position: { page: 5 } });
    client.close();
  });

  it('emits groupEnded rejoin_failed with GROUP_NOT_FOUND when the group is gone', async () => {
    const { client, socket } = await member();
    const ended: GroupEndedInfo[] = [];
    client.on('groupEnded', (e) => ended.push(e));
    const next = dropAndReconnect(client, socket);
    next.receive({
      type: 'error',
      reqId: next.lastMessage().reqId,
      code: 'GROUP_NOT_FOUND',
      message: 'x',
    });
    expect(ended).toEqual([
      { groupId: GROUP_ID, reason: 'rejoin_failed', code: 'GROUP_NOT_FOUND' },
    ]);
    expect(client.getSnapshot().group).toEqual({
      status: 'ended',
      groupId: GROUP_ID,
      reason: 'rejoin_failed',
      code: 'GROUP_NOT_FOUND',
    });
    expect(client.getState().status).toBe('connected');
    // A new join is allowed afterwards (R2-L4).
    void client.joinGroup(GROUP_ID).catch(() => {});
    expect(next.lastMessage()).toMatchObject({ type: 'group.join' });
    client.close();
  });

  it('ends the group with REQUEST_TIMEOUT when the rejoin is not answered', async () => {
    const { client, socket } = await member();
    const ended: GroupEndedInfo[] = [];
    client.on('groupEnded', (e) => ended.push(e));
    const next = dropAndReconnect(client, socket);
    vi.advanceTimersByTime(10_000);
    expect(ended).toEqual([
      { groupId: GROUP_ID, reason: 'rejoin_failed', code: 'REQUEST_TIMEOUT' },
    ]);
    expect(next.closeCalls).toHaveLength(1);
    client.close();
  });

  it('stays rejoining when the connection drops again before the answer, and retries', async () => {
    const { client, socket } = await member();
    const next = dropAndReconnect(client, socket);
    expect(next.lastMessage().type).toBe('group.join');
    const third = dropAndReconnect(client, next);
    expect(client.getSnapshot().group?.status).toBe('rejoining');
    expect(third.lastMessage()).toMatchObject({ type: 'group.join', groupId: GROUP_ID });
    client.close();
  });

  it('refuses create and join while rejoining', async () => {
    const { client, socket } = await member();
    const next = dropAndReconnect(client, socket);
    const sentBefore = next.sent.length;
    let error: unknown;
    try {
      await client.createGroup({});
    } catch (err) {
      error = err;
    }
    expect(isSyncClientError(error, 'ALREADY_IN_GROUP')).toBe(true);
    expect(next.sent).toHaveLength(sentBefore);
    client.close();
  });

  it('ends a rejoining group when a fatal error closes the client', async () => {
    const { client, socket } = await member();
    const ended: GroupEndedInfo[] = [];
    client.on('groupEnded', (e) => ended.push(e));
    socket.serverClose(1006);
    vi.advanceTimersByTime(500);
    const next = FakeWebSocket.last;
    next.open();
    next.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
    next.receive({
      type: 'error',
      reqId: next.lastMessage().reqId,
      code: 'INVALID_API_KEY',
      message: 'x',
    });
    expect(ended).toEqual([
      { groupId: GROUP_ID, reason: 'rejoin_failed', code: 'INVALID_API_KEY' },
    ]);
    expect(client.getSnapshot()).toMatchObject({
      connection: { status: 'closed', reason: 'fatal' },
      group: { status: 'ended' },
    });
  });

  it('ends a rejoining group when the client gives up', async () => {
    const { client, socket } = await member({ reconnect: { maxAttempts: 1 } });
    const ended: GroupEndedInfo[] = [];
    client.on('groupEnded', (e) => ended.push(e));
    socket.serverClose(1006);
    vi.advanceTimersByTime(500);
    FakeWebSocket.last.serverClose(1006);
    expect(ended).toEqual([
      { groupId: GROUP_ID, reason: 'rejoin_failed', code: 'RECONNECT_FAILED' },
    ]);
    expect(client.getState()).toMatchObject({ status: 'closed', reason: 'gave_up' });
  });
});
