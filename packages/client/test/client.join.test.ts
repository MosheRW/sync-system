import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSyncClientError } from '../src/errors.js';
import { indicatorOf } from '../src/state.js';
import {
  LIMITS,
  PARTICIPANT_ID,
  connectedClient,
  makeClient,
  serverHandshake,
} from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';

const GROUP_ID = 'G'.repeat(43);
const REQUEST_ID = 'R'.repeat(22);
const TICKET = `eyJ2IjoxfQ.${'S'.repeat(43)}`;

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

function joined(reqId?: string) {
  return {
    type: 'group.joined',
    ...(reqId === undefined ? {} : { reqId }),
    groupId: GROUP_ID,
    participantId: PARTICIPANT_ID,
    role: 'member',
    metadata: { m: 1 },
    token: 'h.p.s',
    leaderOnline: true,
    hasPosition: false,
  };
}

async function connectedWith(joinMethods: ('A' | 'B' | 'C' | 'D')[]) {
  const client = makeClient();
  const connecting = client.connect();
  const socket = FakeWebSocket.last;
  serverHandshake(socket, { joinMethods });
  await connecting;
  return { client, socket };
}

describe('joinByCode (#10 AC12, AC39)', () => {
  it('normalizes the codes and sends them with the display name', async () => {
    const { client, socket } = await connectedClient();
    const joining = client.joinByCode(' 123-456 ', { doorCode: '65 43 21', displayName: ' Dana ' });
    expect(socket.lastMessage()).toEqual({
      type: 'group.joinByCode',
      reqId: 'c2',
      joinCode: '123456',
      doorCode: '654321',
      displayName: 'Dana',
    });
    socket.receive(joined('c2'));
    expect((await joining).groupId).toBe(GROUP_ID);
    void client.joinByCode('abcd-efgh').catch(() => {});
    client.close();

    const second = await connectedClient();
    void second.client.joinByCode('abcd-efgh').catch(() => {});
    expect(second.socket.lastMessage()).toEqual({
      type: 'group.joinByCode',
      reqId: 'c2',
      joinCode: 'ABCDEFGH',
    });
    second.client.close();
  });

  it('rejects bad codes, door codes and names locally, sending nothing (R9)', async () => {
    const { client, socket } = await connectedClient();
    const sent = socket.sent.length;
    for (const [code, options, expected, field] of [
      ['12345', undefined, 'INVALID_JOIN_CODE', 'code'],
      ['1234567', undefined, 'INVALID_JOIN_CODE', 'code'],
      ['ABCDEFG0', undefined, 'INVALID_JOIN_CODE', 'code'],
      [123456, undefined, 'INVALID_JOIN_CODE', 'code'],
      ['123456', { doorCode: '12345' }, 'INVALID_JOIN_CODE', 'doorCode'],
      ['123456', { doorCode: 654321 }, 'INVALID_JOIN_CODE', 'doorCode'],
      ['123456', { displayName: '' }, 'INVALID_DISPLAY_NAME', undefined],
      ['123456', { displayName: 'x'.repeat(33) }, 'INVALID_DISPLAY_NAME', undefined],
      [
        '123456',
        { displayName: `a${String.fromCharCode(0xd800)}` },
        'INVALID_DISPLAY_NAME',
        undefined,
      ],
      [
        '123456',
        { displayName: `a${String.fromCharCode(0x200b)}b` },
        'INVALID_DISPLAY_NAME',
        undefined,
      ],
      [
        '123456',
        { displayName: `a${String.fromCharCode(0x202e)}b` },
        'INVALID_DISPLAY_NAME',
        undefined,
      ],
    ] as const) {
      const error = await rejection(client.joinByCode(code as never, options as never));
      expect(isSyncClientError(error, expected), `${String(code)} ${JSON.stringify(options)}`).toBe(
        true,
      );
      if (field !== undefined && isSyncClientError(error, 'INVALID_JOIN_CODE')) {
        expect(error.details).toEqual({ field });
      }
    }
    expect(socket.sent).toHaveLength(sent);
    client.close();
  });

  it('rejects a code type the app does not allow with JOIN_METHOD_UNAVAILABLE', async () => {
    const onlyC = await connectedWith(['C', 'D']);
    expect(
      isSyncClientError(
        await rejection(onlyC.client.joinByCode('123456')),
        'JOIN_METHOD_UNAVAILABLE',
      ),
    ).toBe(true);
    onlyC.client.close();
    const onlyA = await connectedWith(['A']);
    expect(
      isSyncClientError(
        await rejection(onlyA.client.joinByCode('ABCDEFGH')),
        'JOIN_METHOD_UNAVAILABLE',
      ),
    ).toBe(true);
    expect(
      isSyncClientError(await rejection(onlyA.client.joinByQr(TICKET)), 'JOIN_METHOD_UNAVAILABLE'),
    ).toBe(true);
    onlyA.client.close();
  });

  it.each([
    ['DOOR_CODE_REQUIRED', undefined],
    ['DOOR_CODE_WRONG', undefined],
    ['CODE_NOT_FOUND', undefined],
    ['JOIN_PAUSED', { retryAfterMs: 1000 }],
    ['APPROVAL_QUEUE_FULL', { maxPending: 10 }],
    ['RATE_LIMITED', { retryAfterMs: 5 }],
    ['QR_INVALID', undefined],
    ['QR_EXPIRED', undefined],
  ] as const)('rejects with the server code %s and typed details', async (code, details) => {
    const { client, socket } = await connectedClient();
    const joining = client.joinByCode('123456');
    socket.receive({
      type: 'error',
      reqId: 'c2',
      code,
      message: 'x',
      ...(details === undefined ? {} : { details: { ...details, extra: 'dropped' } }),
    });
    const error = await rejection(joining);
    expect(isSyncClientError(error, code)).toBe(true);
    if (isSyncClientError(error)) {
      expect(error.request).toBe('group.joinByCode');
      expect(error.details).toEqual(details);
    }
    expect(client.getSnapshot().group).toBeNull();
    client.close();
  });

  it('names the join request in RATE_LIMITED', async () => {
    const { client, socket } = await connectedClient();
    const joining = client.joinByCode('123456');
    socket.receive({ type: 'error', reqId: 'c2', code: 'RATE_LIMITED', message: 'x' });
    const error = await rejection(joining);
    expect((error as Error).message).toBe('Too many join attempts');
    client.close();
  });
});

describe('approval (#10 AC19-AC22, AC39)', () => {
  async function pending() {
    const { client, socket } = await connectedClient();
    const joining = client.joinByCode('123456', { displayName: 'Dana' });
    socket.receive({
      type: 'join.pending',
      reqId: 'c2',
      requestId: REQUEST_ID,
      timeoutMs: 120_000,
    });
    await Promise.resolve();
    return { client, socket, joining };
  }

  it('waits in awaiting_approval and resolves on the unsolicited group.joined', async () => {
    const { client, socket, joining } = await pending();
    const group = client.getSnapshot().group;
    expect(group).toEqual({
      status: 'awaiting_approval',
      requestId: REQUEST_ID,
      expiresAt: expect.any(Number) as number,
    });
    expect(indicatorOf(client.getSnapshot())).toBe('awaiting_approval');
    // Busy for any other group request.
    expect(
      isSyncClientError(await rejection(client.joinByCode('123456')), 'ALREADY_IN_GROUP'),
    ).toBe(true);
    expect(isSyncClientError(await rejection(client.createGroup({})), 'ALREADY_IN_GROUP')).toBe(
      true,
    );
    socket.receive(joined());
    expect(await joining).toMatchObject({ groupId: GROUP_ID, role: 'member' });
    expect(client.getSnapshot().group).toMatchObject({ status: 'active', role: 'member' });
    expect(indicatorOf(client.getSnapshot())).toBe('following');
    client.close();
  });

  it.each(['JOIN_DENIED', 'APPROVAL_TIMEOUT', 'GROUP_FULL', 'GROUP_ENDED'] as const)(
    'rejects with %s and clears the state',
    async (code) => {
      const { client, socket, joining } = await pending();
      const errors = vi.fn();
      client.on('error', errors);
      socket.receive({ type: 'error', code, message: 'x' });
      const error = await rejection(joining);
      expect(isSyncClientError(error, code)).toBe(true);
      expect(client.getSnapshot().group).toBeNull();
      expect(errors).not.toHaveBeenCalled();
      client.close();
    },
  );

  it('cancels: join.cancel, then JOIN_CANCELLED for the join', async () => {
    const { client, socket, joining } = await pending();
    const cancelling = client.cancelJoin();
    expect(socket.lastMessage()).toEqual({ type: 'join.cancel', reqId: 'c3' });
    socket.receive({ type: 'join.cancelled', reqId: 'c3', requestId: REQUEST_ID });
    await cancelling;
    expect(isSyncClientError(await rejection(joining), 'JOIN_CANCELLED')).toBe(true);
    expect(client.getSnapshot().group).toBeNull();
    expect(isSyncClientError(await rejection(client.cancelJoin()), 'JOIN_REQUEST_NOT_FOUND')).toBe(
      true,
    );
    client.close();
  });

  it('cancel racing an approval: the join resolves and cancelJoin rejects', async () => {
    const { client, socket, joining } = await pending();
    const cancelling = client.cancelJoin();
    socket.receive(joined());
    socket.receive({
      type: 'error',
      reqId: 'c3',
      code: 'JOIN_REQUEST_NOT_FOUND',
      message: 'x',
    });
    expect((await joining).groupId).toBe(GROUP_ID);
    expect(isSyncClientError(await rejection(cancelling), 'JOIN_REQUEST_NOT_FOUND')).toBe(true);
    expect(client.getSnapshot().group).toMatchObject({ status: 'active' });
    client.close();
  });

  it('loses the request with the connection and never re-requests (Q6.3)', async () => {
    const { client, socket, joining } = await pending();
    socket.serverClose(1006);
    expect(isSyncClientError(await rejection(joining), 'CONNECTION_LOST')).toBe(true);
    expect(client.getSnapshot().group).toBeNull();
    vi.advanceTimersByTime(1000);
    const next = FakeWebSocket.last;
    serverHandshake(next);
    await Promise.resolve();
    expect(next.messages.map((m) => m.type)).toEqual(['hello']);
    client.close();
  });

  it('rejects with CLOSED on close()', async () => {
    const { client, joining } = await pending();
    client.close();
    expect(isSyncClientError(await rejection(joining), 'CLOSED')).toBe(true);
    expect(client.getSnapshot().group).toBeNull();
  });

  it('drops the connection when the local guard passes (deadline + requestTimeoutMs)', async () => {
    const { client, socket, joining } = await pending();
    vi.advanceTimersByTime(120_000 + 10_000 - 1);
    expect(client.getSnapshot().group).toMatchObject({ status: 'awaiting_approval' });
    vi.advanceTimersByTime(1);
    const error = await rejection(joining);
    expect(isSyncClientError(error, 'REQUEST_TIMEOUT')).toBe(true);
    expect(client.getSnapshot().group).toBeNull();
    expect(socket.closeCalls.length).toBeGreaterThan(0);
    client.close();
  });

  it('cancelJoin without a pending request rejects locally', async () => {
    const { client } = await connectedClient();
    expect(isSyncClientError(await rejection(client.cancelJoin()), 'JOIN_REQUEST_NOT_FOUND')).toBe(
      true,
    );
    client.close();
    expect(isSyncClientError(await rejection(client.cancelJoin()), 'NOT_CONNECTED')).toBe(true);
  });
});

describe('joinByQr (#10 AC24, AC39)', () => {
  it('sends the ticket and resolves on group.joined', async () => {
    const { client, socket } = await connectedClient();
    const joining = client.joinByQr(TICKET, { displayName: 'Dana' });
    expect(socket.lastMessage()).toEqual({
      type: 'group.joinByQr',
      reqId: 'c2',
      ticket: TICKET,
      displayName: 'Dana',
    });
    socket.receive(joined('c2'));
    expect((await joining).groupId).toBe(GROUP_ID);
    client.close();
  });

  it('rejects a string that is not a ticket locally with QR_INVALID', async () => {
    const { client, socket } = await connectedClient();
    const sent = socket.sent.length;
    for (const bad of [
      '',
      'x',
      `${'a'.repeat(213)}.${'S'.repeat(43)}`,
      `a.b.${'S'.repeat(43)}`,
      7,
    ]) {
      const error = await rejection(client.joinByQr(bad as never));
      expect(isSyncClientError(error, 'QR_INVALID')).toBe(true);
      if (isSyncClientError(error)) expect(error.source).toBe('client');
    }
    expect(socket.sent).toHaveLength(sent);
    client.close();
  });

  it('goes through approval in a B group', async () => {
    const { client, socket } = await connectedClient();
    const joining = client.joinByQr(TICKET);
    socket.receive({ type: 'join.pending', reqId: 'c2', requestId: REQUEST_ID, timeoutMs: 1000 });
    await Promise.resolve();
    expect(client.getSnapshot().group?.status).toBe('awaiting_approval');
    socket.receive({ type: 'error', code: 'JOIN_DENIED', message: 'x' });
    const error = await rejection(joining);
    expect(isSyncClientError(error, 'JOIN_DENIED')).toBe(true);
    if (isSyncClientError(error)) expect(error.request).toBe('group.joinByQr');
    client.close();
  });

  it('never puts the ticket or codes in errors (AC42)', async () => {
    const { client, socket } = await connectedClient();
    const joining = client.joinByQr(TICKET);
    socket.receive({ type: 'error', reqId: 'c2', code: 'QR_INVALID', message: 'x' });
    const error = await rejection(joining);
    expect(JSON.stringify(error)).not.toContain(TICKET);
    expect(String((error as Error).message)).not.toContain(TICKET);
    const local = await rejection(client.joinByCode('12345x', { doorCode: '999999' }));
    expect(JSON.stringify(local)).not.toContain('12345');
    expect(JSON.stringify(local)).not.toContain('999999');
    client.close();
  });
});

describe('connected info (#10 AC4)', () => {
  it('exposes the join methods and limits from hello.ok', async () => {
    const { client } = await connectedWith(['B', 'D']);
    expect(client.getState()).toMatchObject({ joinMethods: ['B', 'D'], limits: LIMITS });
    client.close();
  });
});
