import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncClient } from '../src/client.js';
import { type SyncClientError, isSyncClientError } from '../src/errors.js';
import {
  CREATED_FIELDS,
  LIMITS,
  PARTICIPANT_ID,
  connectedClient,
  makeClient,
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

function thrown(fn: () => void): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

async function leader(limits = LIMITS): Promise<{ client: SyncClient; socket: FakeWebSocket }> {
  const { client, socket } = await connectedClient({}, limits);
  const creating = client.createGroup({ book: 'b' });
  const reqId = socket.lastMessage().reqId;
  socket.receive({
    type: 'group.created',
    handoff: 'auto',
    displayName: 'Guest 1',
    generated: true,
    state: { blockList: [], locked: false, handoff: 'auto' },
    ...CREATED_FIELDS,
    token: 'h.p.s',
    reqId,
    groupId: GROUP_ID,
    participantId: PARTICIPANT_ID,
    role: 'leader',
  });
  await creating;
  return { client, socket };
}

describe('calls while not connected (AC11)', () => {
  it('fail with NOT_CONNECTED in idle, connecting and closed, and send nothing', async () => {
    const client = makeClient();
    const check = async () => {
      expect(isSyncClientError(await rejection(client.createGroup({})), 'NOT_CONNECTED')).toBe(
        true,
      );
      expect(isSyncClientError(await rejection(joinTestGroup(client)), 'NOT_CONNECTED')).toBe(true);
      expect(
        isSyncClientError(
          thrown(() => client.updatePosition(1)),
          'NOT_CONNECTED',
        ),
      ).toBe(true);
    };
    await check();
    const connecting = client.connect().catch(() => {});
    const socket = FakeWebSocket.last;
    socket.open();
    socket.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
    await check();
    expect(socket.messages.map((m) => m.type)).toEqual(['hello']);
    client.close();
    await connecting;
    await check();
    expect(socket.messages.map((m) => m.type)).toEqual(['hello']);
  });

  it('fail with NOT_CONNECTED while reconnecting (waiting and attempting), and send nothing', async () => {
    const { client, socket } = await connectedClient();
    const check = async () => {
      expect(isSyncClientError(await rejection(client.createGroup({})), 'NOT_CONNECTED')).toBe(
        true,
      );
      expect(isSyncClientError(await rejection(joinTestGroup(client)), 'NOT_CONNECTED')).toBe(true);
      expect(
        isSyncClientError(
          thrown(() => client.updatePosition(1)),
          'NOT_CONNECTED',
        ),
      ).toBe(true);
    };

    socket.serverClose(1006);
    expect(client.getState()).toMatchObject({ status: 'reconnecting', attempting: false });
    await check();

    vi.advanceTimersToNextTimer();
    expect(client.getState()).toMatchObject({ status: 'reconnecting', attempting: true });
    const retrySocket = FakeWebSocket.last;
    expect(retrySocket).not.toBe(socket);
    retrySocket.open();
    retrySocket.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
    await check();

    expect(socket.messages.map((m) => m.type)).toEqual(['hello']);
    expect(retrySocket.messages.map((m) => m.type)).toEqual(['hello']);
    client.close();
  });
});

describe('reqId matching (AC17)', () => {
  it('settles overlapping requests answered in reverse order', async () => {
    const { client, socket } = await leader();
    const errors: SyncClientError[] = [];
    client.on('error', (e) => errors.push(e));
    client.updatePosition(1);
    client.updatePosition(2);
    const [first, second] = socket.messages.slice(-2);
    expect([first?.position, second?.position]).toEqual([1, 2]);
    socket.receive({ type: 'position.ack', reqId: second?.reqId });
    socket.receive({
      type: 'error',
      reqId: first?.reqId,
      code: 'NOT_IN_GROUP',
      message: 'x',
    });
    expect(errors.map((e) => [e.code, e.request])).toEqual([['NOT_IN_GROUP', 'position.update']]);
    client.close();
  });

  it('rejects pending requests with CONNECTION_LOST when the socket drops', async () => {
    const { client, socket } = await connectedClient();
    const joining = joinTestGroup(client);
    socket.serverClose(1006);
    const error = await rejection(joining);
    expect(isSyncClientError(error, 'CONNECTION_LOST')).toBe(true);
    client.close();
  });

  it('a create/join without reply in 10 s rejects REQUEST_TIMEOUT and drops the socket (Q-C)', async () => {
    const { client, socket } = await connectedClient();
    const joining = joinTestGroup(client);
    const error = rejection(joining);
    vi.advanceTimersByTime(9_999);
    expect(socket.closeCalls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    const result = await error;
    expect(isSyncClientError(result, 'REQUEST_TIMEOUT')).toBe(true);
    if (isSyncClientError(result)) expect(result.request).toBe('group.joinByCode');
    expect(socket.closeCalls).toHaveLength(1);
    client.close();
  });

  it('a reply of the wrong type rejects the request with INVALID_SERVER_MESSAGE', async () => {
    const { client, socket } = await connectedClient();
    const joining = joinTestGroup(client);
    socket.receive({ type: 'position.ack', reqId: socket.lastMessage().reqId });
    expect(isSyncClientError(await rejection(joining), 'INVALID_SERVER_MESSAGE')).toBe(true);
    client.close();
  });

  it('an invalid frame with a pending reqId rejects that request (AC10)', async () => {
    const { client, socket } = await connectedClient();
    const joining = joinTestGroup(client);
    socket.receive({ type: 'group.joined', reqId: socket.lastMessage().reqId, groupId: 5 });
    expect(isSyncClientError(await rejection(joining), 'INVALID_SERVER_MESSAGE')).toBe(true);
    client.close();
  });
});

describe('one group request in flight (L5, R2-L4)', () => {
  it('rejects a second create/join while one is pending, sending one frame', async () => {
    const { client, socket } = await connectedClient();
    void joinTestGroup(client).catch(() => {});
    const second = await rejection(joinTestGroup(client));
    const third = await rejection(client.createGroup({}));
    expect(isSyncClientError(second, 'REQUEST_IN_PROGRESS')).toBe(true);
    expect(isSyncClientError(third, 'REQUEST_IN_PROGRESS')).toBe(true);
    expect(socket.messages.filter((m) => m.type !== 'hello')).toHaveLength(1);
    client.close();
  });

  it('clears the flag after a server error', async () => {
    const { client, socket } = await connectedClient();
    const joining = joinTestGroup(client);
    socket.receive({ type: 'error', reqId: 'c2', code: 'GROUP_NOT_FOUND', message: 'x' });
    await rejection(joining);
    void joinTestGroup(client).catch(() => {});
    expect(socket.lastMessage()).toMatchObject({ type: 'group.joinByCode', reqId: 'c3' });
    client.close();
  });

  it('clears the flag after close() and a new connect()', async () => {
    const { client } = await connectedClient();
    const joining = joinTestGroup(client);
    client.close();
    expect(isSyncClientError(await rejection(joining), 'CLOSED')).toBe(true);
    const reconnecting = client.connect();
    // close() + connect() keeps a minimum gap between sockets (R2-L6).
    vi.advanceTimersByTime(500);
    const socket = FakeWebSocket.last;
    socket.open();
    socket.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
    socket.receive({
      type: 'hello.ok',
      namespace: 'app-a',
      reqId: socket.lastMessage().reqId,
      participantId: 'p2',
      joinMethods: ['A', 'B', 'C', 'D'],
      limits: LIMITS,
      defaultHandoff: 'auto',
    });
    await reconnecting;
    void joinTestGroup(client).catch(() => {});
    expect(socket.lastMessage().type).toBe('group.joinByCode');
    client.close();
  });
});

describe('updatePosition rules (AC18)', () => {
  it('throws NOT_IN_GROUP without a group, and NOT_LEADER for a member, sending nothing', async () => {
    const { client, socket } = await connectedClient();
    expect(
      isSyncClientError(
        thrown(() => client.updatePosition(1)),
        'NOT_IN_GROUP',
      ),
    ).toBe(true);
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
    const sentBefore = socket.sent.length;
    const notLeader = thrown(() => client.updatePosition(1));
    expect(isSyncClientError(notLeader, 'NOT_LEADER')).toBe(true);
    expect((notLeader as Error).message).toBe('Only the leader can update the position');
    expect(socket.sent).toHaveLength(sentBefore);
    client.close();
  });

  it('sends position.update for the leader and records the position in the snapshot', async () => {
    const { client, socket } = await leader();
    client.updatePosition({ page: 2 });
    expect(socket.lastMessage()).toMatchObject({ type: 'position.update', position: { page: 2 } });
    expect(client.getSnapshot().group).toMatchObject({ hasPosition: true, position: { page: 2 } });
    client.close();
  });

  it('rejects values that are not JSON payloads with INVALID_PAYLOAD', async () => {
    const { client, socket } = await leader();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: unknown = 1;
    for (let i = 0; i < 64; i += 1) deep = [deep];
    const sentBefore = socket.sent.length;
    for (const bad of [undefined, cyclic, 10n, Number.NaN, () => 1, deep, new Date()]) {
      expect(
        isSyncClientError(
          thrown(() => client.updatePosition(bad as never)),
          'INVALID_PAYLOAD',
        ),
      ).toBe(true);
    }
    expect(socket.sent).toHaveLength(sentBefore);
    client.close();
  });
});

describe('size checks (AC22)', () => {
  const small = { ...LIMITS, maxMessageBytes: 20 };

  it('accepts a position exactly at the limit and rejects one byte over, sending nothing', async () => {
    const { client, socket } = await leader(small);
    const atLimit = 'x'.repeat(18); // "xxx..." is 20 bytes with the quotes
    client.updatePosition(atLimit);
    expect(socket.lastMessage().position).toBe(atLimit);
    const sentBefore = socket.sent.length;
    const error = thrown(() => client.updatePosition(`${atLimit}x`));
    expect(isSyncClientError(error, 'MESSAGE_TOO_LARGE')).toBe(true);
    if (isSyncClientError(error, 'MESSAGE_TOO_LARGE')) {
      expect(error.details).toEqual({ field: 'position', sizeBytes: 21, limitBytes: 20 });
      expect(error.source).toBe('client');
    }
    expect(socket.sent).toHaveLength(sentBefore);
    client.close();
  });

  it('checks create metadata and the initial position', async () => {
    const { client, socket } = await connectedClient({}, small);
    const sentBefore = socket.sent.length;
    const metadataError = await rejection(client.createGroup({ k: 'x'.repeat(20) }));
    expect(isSyncClientError(metadataError, 'MESSAGE_TOO_LARGE')).toBe(true);
    if (isSyncClientError(metadataError, 'MESSAGE_TOO_LARGE')) {
      expect(metadataError.details.field).toBe('metadata');
    }
    const positionError = await rejection(client.createGroup({}, 'y'.repeat(30)));
    if (isSyncClientError(positionError, 'MESSAGE_TOO_LARGE')) {
      expect(positionError.details.field).toBe('position');
    } else {
      throw new Error('expected MESSAGE_TOO_LARGE');
    }
    expect(socket.sent).toHaveLength(sentBefore);
    client.close();
  });
});

describe('positions are serialized once, when updatePosition() checks them', () => {
  it('sends the checked JSON text even if the app mutates a throttled position', async () => {
    const { client, socket } = await leader();
    for (let i = 0; i < 5; i += 1) client.updatePosition({ page: i });
    const queued: { page: number; extra?: string } = { page: 5 };
    client.updatePosition(queued);
    const sentBefore = socket.sent.length;
    // Mutated while it waits for the trailing send: bigger than maxMessageBytes.
    queued.page = 999;
    queued.extra = 'x'.repeat(LIMITS.maxMessageBytes * 2);
    vi.advanceTimersByTime(1_100);
    expect(socket.sent).toHaveLength(sentBefore + 1);
    const text = socket.sent.at(-1)!;
    expect(text).toBe(
      `{"type":"position.update","reqId":"${String(socket.lastMessage().reqId)}","position":{"page":5}}`,
    );
    expect(client.getState().status).toBe('connected');
    client.close();
  });

  it('re-sends the checked JSON text after RATE_LIMITED, not the mutated object', async () => {
    const { client, socket } = await leader();
    const position: { page: number } = { page: 9 };
    client.on('error', () => {});
    client.updatePosition(position);
    const update = socket.lastMessage();
    position.page = 10;
    socket.receive({
      type: 'error',
      reqId: update.reqId,
      code: 'RATE_LIMITED',
      message: 'x',
      details: { retryAfterMs: 200 },
    });
    vi.advanceTimersByTime(200);
    expect(socket.lastMessage()).toMatchObject({ type: 'position.update', position: { page: 9 } });
    expect(socket.lastMessage().reqId).not.toBe(update.reqId);
    client.close();
  });

  it('rejects a position whose toJSON throws with INVALID_PAYLOAD and sends nothing', async () => {
    const { client, socket } = await leader();
    const sentBefore = socket.sent.length;
    const position = {
      toJSON() {
        throw new Error('no');
      },
    };
    expect(
      isSyncClientError(
        thrown(() => client.updatePosition(position as never)),
        'INVALID_PAYLOAD',
      ),
    ).toBe(true);
    expect(socket.sent).toHaveLength(sentBefore);
    client.close();
  });
});

describe('server rejections of position updates (AC23)', () => {
  it('RATE_LIMITED is a typed error event, the client stays connected and re-sends', async () => {
    const { client, socket } = await leader();
    const errors: SyncClientError[] = [];
    client.on('error', (e) => errors.push(e));
    client.updatePosition({ page: 9 });
    const update = socket.lastMessage();
    socket.receive({
      type: 'error',
      reqId: update.reqId,
      code: 'RATE_LIMITED',
      message: 'x',
      details: { maxLeaderUpdatesPerSecond: 5, retryAfterMs: 200 },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('RATE_LIMITED');
    expect(errors[0]?.details).toEqual({ maxLeaderUpdatesPerSecond: 5, retryAfterMs: 200 });
    expect(client.getState().status).toBe('connected');
    vi.advanceTimersByTime(200);
    expect(socket.lastMessage()).toMatchObject({ type: 'position.update', position: { page: 9 } });
    expect(socket.lastMessage().reqId).not.toBe(update.reqId);
    client.close();
  });

  it('a late RATE_LIMITED for an older position does not re-send it over a newer one', async () => {
    const { client, socket } = await leader();
    const errors: string[] = [];
    client.on('error', (e) => errors.push(e.code));
    client.updatePosition({ page: 'A' });
    const first = socket.lastMessage();
    client.updatePosition({ page: 'B' });
    const second = socket.lastMessage();
    expect(second.position).toEqual({ page: 'B' });
    const sentBefore = socket.sent.length;
    socket.receive({
      type: 'error',
      reqId: first.reqId,
      code: 'RATE_LIMITED',
      message: 'x',
      details: { retryAfterMs: 200 },
    });
    // Well past retryAfterMs, still inside the 20 s ack timeout.
    vi.advanceTimersByTime(5_000);
    expect(errors).toEqual(['RATE_LIMITED']);
    expect(socket.sent).toHaveLength(sentBefore);
    expect(client.getSnapshot().group).toMatchObject({ position: { page: 'B' } });
    client.close();
  });

  it('MESSAGE_TOO_LARGE is a typed error event and the client stays connected', async () => {
    const { client, socket } = await leader();
    const errors: SyncClientError[] = [];
    client.on('error', (e) => errors.push(e));
    client.updatePosition(1);
    socket.receive({
      type: 'error',
      reqId: socket.lastMessage().reqId,
      code: 'MESSAGE_TOO_LARGE',
      message: 'x',
      details: { field: 'position', limitBytes: 1 },
    });
    expect(errors.map((e) => e.code)).toEqual(['MESSAGE_TOO_LARGE']);
    expect(client.getState().status).toBe('connected');
    client.close();
  });

  it('a late RATE_LIMITED for an unknown reqId is an error event and is not re-queued', async () => {
    const { client, socket } = await leader();
    const errors: SyncClientError[] = [];
    client.on('error', (e) => errors.push(e));
    const sentBefore = socket.sent.length;
    socket.receive({ type: 'error', reqId: 'c999', code: 'RATE_LIMITED', message: 'x' });
    vi.advanceTimersByTime(20_000);
    expect(errors.map((e) => e.code)).toEqual(['RATE_LIMITED']);
    expect(socket.sent).toHaveLength(sentBefore);
    client.close();
  });
});

describe('position ack timeout (M4, Q-C)', () => {
  it('only emits REQUEST_TIMEOUT while other frames keep arriving', async () => {
    const { client, socket } = await leader();
    const errors: SyncClientError[] = [];
    client.on('error', (e) => errors.push(e));
    client.updatePosition(1);
    for (let t = 0; t < 20_000; t += 5_000) {
      vi.advanceTimersByTime(5_000);
      socket.receive({ type: 'roster.updated' });
    }
    expect(errors.map((e) => [e.code, e.request])).toEqual([
      ['REQUEST_TIMEOUT', 'position.update'],
    ]);
    expect(client.getState().status).toBe('connected');
    expect(socket.closeCalls).toHaveLength(0);
    client.close();
  });

  it('drops the socket when nothing at all came from the server', async () => {
    const { client, socket } = await leader();
    const errors: SyncClientError[] = [];
    client.on('error', (e) => errors.push(e));
    client.updatePosition(1);
    vi.advanceTimersByTime(19_999);
    expect(socket.closeCalls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(errors[0]?.code).toBe('REQUEST_TIMEOUT');
    expect(socket.closeCalls).toHaveLength(1);
    expect(client.getState().status).not.toBe('connected');
    client.close();
  });
});
