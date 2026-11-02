import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSyncClientError } from '../src/errors.js';
import {
  LIMITS,
  PARTICIPANT_ID,
  TEST_API_KEY,
  makeClient,
  serverHandshake,
} from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';

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

describe('connect and handshake (AC8, AC9)', () => {
  it('waits for welcome, sends hello, and resolves only on hello.ok', async () => {
    const client = makeClient();
    let resolved = false;
    const connecting = client.connect().then((info) => {
      resolved = true;
      return info;
    });
    const socket = FakeWebSocket.last;
    expect(socket.url).toBe('ws://127.0.0.1:1/ws');
    socket.open();
    expect(socket.sent).toEqual([]);

    socket.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
    const hello = socket.lastMessage();
    expect(hello).toEqual({
      type: 'hello',
      reqId: 'c1',
      protocolVersion: 1,
      apiKey: TEST_API_KEY,
      appVersion: '1.0.0',
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(client.getState().status).toBe('connecting');

    socket.receive({
      type: 'hello.ok',
      namespace: 'app-a',
      reqId: 'c1',
      participantId: PARTICIPANT_ID,
      limits: LIMITS,
    });
    const info = await connecting;
    expect(info).toEqual({ participantId: PARTICIPANT_ID, namespace: 'app-a', limits: LIMITS });
    expect(client.getState()).toEqual({
      status: 'connected',
      participantId: PARTICIPANT_ID,
      namespace: 'app-a',
      limits: LIMITS,
    });
    expect(client.getSnapshot().connection).toBe(client.getState());
  });

  it('connect() while connecting returns the same promise, and resolves at once when connected', async () => {
    const client = makeClient();
    const first = client.connect();
    expect(client.connect()).toBe(first);
    serverHandshake(FakeWebSocket.last);
    const info = await first;
    await expect(client.connect()).resolves.toBe(info);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('connects with the checked href (R2-L3)', () => {
    const client = makeClient({ url: 'WS://LOCALHOST:8080' });
    void client.connect().catch(() => {});
    expect(FakeWebSocket.last.url).toBe('ws://localhost:8080/');
    client.close();
  });
});

describe('client-side version check (AC12)', () => {
  it('does not send hello to an unsupported server, closes, and is fatal', async () => {
    const client = makeClient();
    const connecting = client.connect();
    const socket = FakeWebSocket.last;
    socket.open();
    socket.receive({ type: 'welcome', protocolVersion: 2, minProtocolVersion: 2 });

    const error = await rejection(connecting);
    expect(isSyncClientError(error, 'SERVER_UNSUPPORTED')).toBe(true);
    if (!isSyncClientError(error, 'SERVER_UNSUPPORTED')) return;
    expect(error.fatal).toBe(true);
    expect(error.details).toEqual({
      clientProtocolVersion: 1,
      minServerProtocolVersion: 1,
      serverProtocolVersion: 2,
      serverMinProtocolVersion: 2,
    });
    expect(socket.sent).toEqual([]);
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: 'SERVER_UNSUPPORTED' }]);
    expect(client.getState()).toMatchObject({ status: 'closed', reason: 'fatal', error });
  });

  it('treats out-of-bounds hello.ok limits as fatal SERVER_UNSUPPORTED (M1, R2-L2)', async () => {
    for (const limits of [
      { ...LIMITS, maxMessageBytes: 1_048_577 },
      { ...LIMITS, maxLeaderUpdatesPerSecond: 1e6 },
      { ...LIMITS, maxGroupSize: 10_001 },
    ]) {
      FakeWebSocket.reset();
      const client = makeClient();
      const connecting = client.connect();
      const socket = FakeWebSocket.last;
      socket.open();
      socket.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
      socket.receive({
        type: 'hello.ok',
        reqId: 'c1',
        participantId: 'p',
        namespace: 'app-a',
        limits,
      });
      const error = await rejection(connecting);
      expect(isSyncClientError(error, 'SERVER_UNSUPPORTED')).toBe(true);
      if (!isSyncClientError(error, 'SERVER_UNSUPPORTED')) return;
      expect(error.fatal).toBe(true);
      expect(error.details.limit).toBeDefined();
      expect(client.getSnapshot().connection.status).toBe('closed');
      vi.advanceTimersByTime(600_000);
      expect(FakeWebSocket.instances).toHaveLength(1);
    }
  });
});

describe('fatal handshake rejections (AC13, AC14, Q-A)', () => {
  it.each([
    ['INVALID_API_KEY', undefined],
    ['INVALID_APP_VERSION', undefined],
    ['PROTOCOL_TOO_OLD', { minProtocolVersion: 2 }],
    ['APP_VERSION_TOO_OLD', { minAppVersion: '2.0.0' }],
    ['INVALID_MESSAGE', undefined],
    ['HANDSHAKE_REQUIRED', undefined],
    ['ALREADY_AUTHENTICATED', undefined],
  ] as const)('%s closes the client and never reconnects', async (code, details) => {
    const client = makeClient();
    const connecting = client.connect();
    const socket = FakeWebSocket.last;
    socket.open();
    socket.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
    socket.receive({
      type: 'error',
      reqId: 'c1',
      code,
      message: 'x',
      ...(details ? { details } : {}),
    });

    const error = await rejection(connecting);
    expect(isSyncClientError(error, code)).toBe(true);
    if (!isSyncClientError(error)) return;
    expect(error.fatal).toBe(true);
    expect(error.source).toBe('server');
    if (details) expect(error.details).toEqual(details);
    expect(socket.closeCalls).toHaveLength(1);
    expect(client.getState()).toMatchObject({ status: 'closed', reason: 'fatal' });

    socket.serverClose(4001);
    vi.advanceTimersByTime(600_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('a bare close 4001 during the handshake is fatal HANDSHAKE_REJECTED', async () => {
    const client = makeClient();
    const connecting = client.connect();
    const socket = FakeWebSocket.last;
    socket.open();
    socket.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
    socket.serverClose(4001);
    const error = await rejection(connecting);
    expect(isSyncClientError(error, 'HANDSHAKE_REJECTED')).toBe(true);
    vi.advanceTimersByTime(600_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
