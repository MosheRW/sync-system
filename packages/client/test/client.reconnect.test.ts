import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncClient } from '../src/client.js';
import { type SyncClientError, isSyncClientError } from '../src/errors.js';
import type { SyncClientOptions } from '../src/options.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_STABLE_AFTER_MS } from '../src/options.js';
import { type TokenStorage, memoryStorage } from '../src/storage.js';
import type { ConnectionState, GroupEndedInfo } from '../src/state.js';
import {
  CREATED_FIELDS,
  LIMITS,
  PARTICIPANT_ID,
  connectedClient,
  makeClient,
  serverHandshake,
  joinTestGroup,
} from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';
import { fakeToken } from './helpers/tokens.js';

const GROUP_ID = 'G'.repeat(43);

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

function reconnecting(client: SyncClient): Extract<ConnectionState, { status: 'reconnecting' }> {
  const state = client.getState();
  if (state.status !== 'reconnecting')
    throw new Error(`expected reconnecting, got ${state.status}`);
  return state;
}

/** Advances by the scheduled delay and returns the new socket. */
function nextSocket(client: SyncClient): FakeWebSocket {
  const count = FakeWebSocket.instances.length;
  const { delayMs } = reconnecting(client);
  if (delayMs > 0) vi.advanceTimersByTime(delayMs - 1);
  expect(FakeWebSocket.instances).toHaveLength(count);
  vi.advanceTimersByTime(delayMs > 0 ? 1 : 0);
  expect(FakeWebSocket.instances).toHaveLength(count + 1);
  return FakeWebSocket.last;
}

describe('automatic reconnect (AC26)', () => {
  it.each([
    ['abnormal close 1006', (s: FakeWebSocket) => s.serverClose(1006), 500],
    ['socket error', (s: FakeWebSocket) => s.error(), 500],
    ['going away 1001', (s: FakeWebSocket) => s.serverClose(1001), 2000],
    ['app connection limit 4003', (s: FakeWebSocket) => s.serverClose(4003), 2000],
    ['too many messages 4008', (s: FakeWebSocket) => s.serverClose(4008), 2000],
  ])('reconnects after %s with the expected first delay cap', async (_name, drop, delay) => {
    const { client, socket } = await connectedClient();
    drop(socket);
    expect(reconnecting(client)).toMatchObject({ attempt: 1, delayMs: delay, attempting: false });
    const next = nextSocket(client);
    expect(reconnecting(client).attempting).toBe(true);
    serverHandshake(next);
    expect(client.getState().status).toBe('connected');
    client.close();
  });

  it('retries a handshake timeout (4002) and an HTTP 503 (error + 1006) on the normal sequence', () => {
    const client = makeClient();
    void client.connect().catch(() => {});
    const first = FakeWebSocket.last;
    first.open();
    first.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
    first.serverClose(4002);
    expect(reconnecting(client)).toMatchObject({ attempt: 1, delayMs: 500 });
    const second = nextSocket(client);
    second.error();
    second.serverClose(1006);
    expect(reconnecting(client)).toMatchObject({ attempt: 2, delayMs: 1000 });
    client.close();
  });

  it('retries the retryable handshake errors', () => {
    const client = makeClient();
    const errors: SyncClientError[] = [];
    client.on('error', (e) => errors.push(e));
    void client.connect().catch(() => {});
    for (const code of ['APP_CONNECTION_LIMIT', 'HANDSHAKE_TIMEOUT', 'INTERNAL_ERROR'] as const) {
      const socket = FakeWebSocket.last;
      socket.open();
      socket.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
      socket.receive({ type: 'error', reqId: socket.lastMessage().reqId, code, message: 'x' });
      expect(socket.closeCalls).toHaveLength(1);
      nextSocket(client);
    }
    expect(errors.map((e) => e.code)).toEqual([
      'APP_CONNECTION_LIMIT',
      'HANDSHAKE_TIMEOUT',
      'INTERNAL_ERROR',
    ]);
    expect(errors.every((e) => !e.fatal)).toBe(true);
    client.close();
  });

  it('retries a schema-invalid hello.ok (unsafe integer limit)', () => {
    const client = makeClient();
    void client.connect().catch(() => {});
    const socket = FakeWebSocket.last;
    socket.open();
    socket.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
    socket.receive({
      type: 'hello.ok',
      namespace: 'app-a',
      reqId: 'c1',
      participantId: 'p',
      joinMethods: ['A'],
      limits: { ...LIMITS, maxMessageBytes: 2 ** 53 },
      defaultHandoff: 'auto',
    });
    expect(reconnecting(client).attempt).toBe(1);
    client.close();
  });

  it('retries after the attempt timeout (no welcome in requestTimeoutMs)', () => {
    const client = makeClient();
    const errors: SyncClientError[] = [];
    client.on('error', (e) => errors.push(e));
    void client.connect().catch(() => {});
    FakeWebSocket.last.open();
    vi.advanceTimersByTime(10_000);
    expect(errors.map((e) => [e.code, e.request])).toEqual([['REQUEST_TIMEOUT', 'hello']]);
    expect(FakeWebSocket.last.closeCalls).toHaveLength(1);
    expect(reconnecting(client).attempt).toBe(1);
    client.close();
  });

  it('grows the delays with full jitter and caps them at maxDelayMs', () => {
    const client = makeClient({ random: () => 0.5 });
    void client.connect().catch(() => {});
    const delays: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      FakeWebSocket.last.serverClose(1006);
      delays.push(reconnecting(client).delayMs);
      vi.advanceTimersByTime(reconnecting(client).delayMs);
    }
    expect(delays).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
    client.close();
  });

  it('caps 4003 at 30 s (Q-E)', () => {
    const client = makeClient();
    void client.connect().catch(() => {});
    const delays: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      FakeWebSocket.last.serverClose(4003);
      delays.push(reconnecting(client).delayMs);
      vi.advanceTimersByTime(reconnecting(client).delayMs);
    }
    expect(delays).toEqual([2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000]);
    client.close();
  });

  it('gives up after maxAttempts with closed(gave_up) and RECONNECT_FAILED', async () => {
    const client = makeClient({ reconnect: { maxAttempts: 3 } });
    const connecting = client.connect();
    FakeWebSocket.last.serverClose(1006);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(reconnecting(client).attempt).toBe(attempt);
      nextSocket(client).serverClose(1006);
    }
    expect(client.getState()).toMatchObject({ status: 'closed', reason: 'gave_up' });
    let error: unknown;
    try {
      await connecting;
    } catch (err) {
      error = err;
    }
    expect(isSyncClientError(error, 'RECONNECT_FAILED')).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(4);
    vi.advanceTimersByTime(3_600_000);
    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes the old socket once when send() throws, then reconnects', async () => {
    const { client, socket } = await connectedClient();
    socket.throwOnSend = true;
    const joining = joinTestGroup(client).catch((error: unknown) => error);
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: undefined }]);
    expect(isSyncClientError(await joining, 'CONNECTION_LOST')).toBe(true);
    expect(reconnecting(client).attempt).toBe(1);
    nextSocket(client);
    expect(socket.closeCalls).toHaveLength(1);
    client.close();
  });
});

describe('state sequence (AC24)', () => {
  it('idle -> connecting -> connected -> reconnecting(false, true) -> connected -> closed', async () => {
    const client = makeClient();
    const states: string[] = [];
    client.on('state', (s) =>
      states.push(
        s.status === 'reconnecting' ? `reconnecting:${s.attempt}:${s.attempting}` : s.status,
      ),
    );
    const connecting = client.connect();
    serverHandshake(FakeWebSocket.last);
    await connecting;
    FakeWebSocket.last.serverClose(1006);
    serverHandshake(nextSocket(client));
    client.close();
    expect(states).toEqual([
      'connecting',
      'connected',
      'reconnecting:1:false',
      'reconnecting:1:true',
      'connected',
      'closed',
    ]);
  });

  it('a state retryAt is the epoch time of the attempt', async () => {
    const { client, socket } = await connectedClient();
    const before = Date.now();
    socket.serverClose(1006);
    expect(reconnecting(client).retryAt).toBe(before + 500);
    client.close();
  });
});

describe('stability window (H1, AC27, Q-D)', () => {
  it('does not reset the backoff for connections that drop 100 ms after the handshake', async () => {
    const { client, socket } = await connectedClient();
    let current = socket;
    const caps: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(100);
      current.serverClose(1006);
      caps.push(reconnecting(client).delayMs);
      current = nextSocket(client);
      serverHandshake(current);
    }
    expect(caps).toEqual([500, 1000, 2000, 4000, 8000]);
    client.close();
  });

  it('starts at attempt 1 again after a connection stayed up for stableAfterMs', async () => {
    const { client, socket } = await connectedClient();
    socket.serverClose(1006);
    let current = nextSocket(client);
    current.serverClose(1006);
    current = nextSocket(client);
    serverHandshake(current);
    vi.advanceTimersByTime(10_000);
    current.serverClose(1006);
    expect(reconnecting(client)).toMatchObject({ attempt: 1, delayMs: 500 });
    client.close();
  });

  it('a timeout-caused drop grows the streak (M4)', async () => {
    // Stable only after 30 s, so the 10 s request timeouts are short-lived connections.
    const { client, socket } = await connectedClient({ reconnect: { stableAfterMs: 30_000 } });
    void joinTestGroup(client).catch(() => {});
    vi.advanceTimersByTime(10_000);
    expect(socket.closeCalls).toHaveLength(1);
    expect(reconnecting(client)).toMatchObject({ attempt: 1, delayMs: 500 });
    const next = nextSocket(client);
    serverHandshake(next);
    void joinTestGroup(client).catch(() => {});
    vi.advanceTimersByTime(10_000);
    expect(reconnecting(client)).toMatchObject({ attempt: 2, delayMs: 1000 });
    client.close();
  });

  it('resets the attempt count with the stability rule, so long-lived clients do not give up (R2-L5)', async () => {
    const { client, socket } = await connectedClient({ reconnect: { maxAttempts: 1 } });
    let current = socket;
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(10_000);
      current.serverClose(1006);
      current = nextSocket(client);
      serverHandshake(current);
    }
    expect(client.getState().status).toBe('connected');
    client.close();
  });

  it('repeats the handshake and version checks on every reconnect (AC27)', async () => {
    const { client, socket } = await connectedClient();
    socket.serverClose(1006);
    const next = nextSocket(client);
    next.open();
    next.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
    expect(next.lastMessage()).toMatchObject({ type: 'hello', protocolVersion: 1 });
    next.serverClose(1006);
    const third = nextSocket(client);
    third.open();
    third.receive({ type: 'welcome', protocolVersion: 2, minProtocolVersion: 2 });
    expect(third.sent).toEqual([]);
    expect(client.getState()).toMatchObject({ status: 'closed', reason: 'fatal' });
    const state = client.getState();
    if (state.status === 'closed') expect(state.error?.code).toBe('SERVER_UNSUPPORTED');
  });

  it('clears the group request flag after a timeout drop and a reconnect (R2-L4)', async () => {
    const { client } = await connectedClient();
    void joinTestGroup(client).catch(() => {});
    vi.advanceTimersByTime(10_000);
    serverHandshake(nextSocket(client));
    void joinTestGroup(client).catch(() => {});
    expect(FakeWebSocket.last.lastMessage().type).toBe('group.joinByCode');
    client.close();
  });
});

describe('leader drop (#5 AC35, replaces #3 AC29)', () => {
  it('keeps the group as rejoining at the drop and resumes it after the reconnect', async () => {
    const { client, socket } = await connectedClient();
    const creating = client.createGroup({});
    socket.receive({
      type: 'group.created',
      ...CREATED_FIELDS,
      token: 'h.p.s',
      reqId: socket.lastMessage().reqId,
      groupId: GROUP_ID,
      participantId: PARTICIPANT_ID,
      role: 'leader',
    });
    await creating;
    const ended: GroupEndedInfo[] = [];
    client.on('groupEnded', (e) => ended.push(e));
    socket.serverClose(1006);
    expect(ended).toEqual([]);
    expect(client.getSnapshot().group).toMatchObject({ status: 'rejoining', role: 'leader' });
    const next = nextSocket(client);
    serverHandshake(next);
    expect(client.getState().status).toBe('connected');
    // The test token is not decodable, so nothing was stored: the resume
    // ends the group with TOKEN_NOT_FOUND (covered in client.rejoin.test.ts).
    await vi.waitFor(() =>
      expect(client.getSnapshot().group).toMatchObject({
        status: 'ended',
        reason: 'rejoin_failed',
        code: 'TOKEN_NOT_FOUND',
      }),
    );
    expect(next.messages.map((m) => m.type)).toEqual(['hello']);
    client.close();
  });
});

describe('resume timeouts are not stable connections (#7 L4)', () => {
  const KEY = 'sync-system:v1:app-a@127.0.0.1:1';

  /** Lets storage promise chains run. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  }

  function storedTokens(storage: TokenStorage): string[] {
    const text = storage.getItem(KEY) as string | null;
    if (text === null) return [];
    return (JSON.parse(text) as { entries: Array<{ token: string }> }).entries.map((e) => e.token);
  }

  /** A connected member with a stored token, then dropped once. */
  async function droppedMember(extra: Partial<SyncClientOptions>) {
    const storage = memoryStorage();
    const { client, socket } = await connectedClient({ storage, ...extra });
    const joining = joinTestGroup(client);
    const token = fakeToken({ gid: GROUP_ID, role: 'member' });
    socket.receive({
      type: 'group.joined',
      reqId: socket.lastMessage().reqId,
      groupId: GROUP_ID,
      participantId: 'member-pid',
      role: 'member',
      metadata: {},
      token,
      leaderOnline: true,
      hasPosition: false,
    });
    await joining;
    await settle();
    socket.serverClose(1006);
    return { client, storage, token };
  }

  /** Opens the next socket, completes hello and waits for the automatic resume. */
  async function reconnectAndResume(client: SyncClient): Promise<FakeWebSocket> {
    const socket = nextSocket(client);
    serverHandshake(socket);
    await settle();
    expect(socket.lastMessage().type).toBe('group.resume');
    return socket;
  }

  it('gives up after maxAttempts against a server that never answers group.resume (AC10-AC12)', async () => {
    // Default timings: requestTimeoutMs == stableAfterMs == 10 s.
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(DEFAULT_STABLE_AFTER_MS);
    const { client, storage, token } = await droppedMember({ reconnect: { maxAttempts: 4 } });
    const errors: string[] = [];
    client.on('error', (e) => errors.push(e.code));
    const attempts: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      attempts.push(reconnecting(client).attempt);
      await reconnectAndResume(client);
      vi.advanceTimersByTime(DEFAULT_REQUEST_TIMEOUT_MS);
    }
    expect(attempts).toEqual([1, 2, 3, 4]);
    expect(client.getState()).toMatchObject({ status: 'closed', reason: 'gave_up' });
    expect(errors).toContain('RECONNECT_FAILED');
    // The token is kept for a later checkTokens() or connect() (AC12).
    await settle();
    expect(storedTokens(storage)).toEqual([token]);
  });

  it('does not reset the backoff either', async () => {
    const { client } = await droppedMember({});
    const delays: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      delays.push(reconnecting(client).delayMs);
      await reconnectAndResume(client);
      vi.advanceTimersByTime(DEFAULT_REQUEST_TIMEOUT_MS);
    }
    delays.push(reconnecting(client).delayMs);
    expect(delays).toEqual([500, 1000, 2000, 4000]);
    client.close();
  });

  it('does not count a drop while the automatic resume is still pending (L-1)', async () => {
    // The resume timer is longer than the stability window, so the server
    // can close after stableAfterMs while the resume is still unanswered.
    const { client } = await droppedMember({ requestTimeoutMs: 30_000 });
    let socket = await reconnectAndResume(client);
    vi.advanceTimersByTime(DEFAULT_STABLE_AFTER_MS + 5_000);
    socket.serverClose(1006);
    expect(reconnecting(client)).toMatchObject({ attempt: 2, delayMs: 1000 });
    socket = await reconnectAndResume(client);
    vi.advanceTimersByTime(DEFAULT_STABLE_AFTER_MS + 5_000);
    socket.serverClose(1006);
    expect(reconnecting(client)).toMatchObject({ attempt: 3, delayMs: 2000 });
    client.close();
  });

  it('still resets after a successful resume and stableAfterMs connected (AC13)', async () => {
    const { client } = await droppedMember({});
    // One failed resume first, so the reset is visible.
    await reconnectAndResume(client);
    vi.advanceTimersByTime(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(reconnecting(client).attempt).toBe(2);
    const socket = await reconnectAndResume(client);
    socket.receive({
      type: 'group.joined',
      reqId: socket.lastMessage().reqId,
      groupId: GROUP_ID,
      participantId: 'member-pid',
      role: 'member',
      metadata: {},
      token: fakeToken({ gid: GROUP_ID, role: 'member' }),
      leaderOnline: true,
      hasPosition: false,
    });
    await settle();
    expect(client.getSnapshot().group).toMatchObject({ status: 'active' });
    vi.advanceTimersByTime(DEFAULT_STABLE_AFTER_MS);
    socket.serverClose(1006);
    expect(reconnecting(client)).toMatchObject({ attempt: 1, delayMs: 500 });
    client.close();
  });
});
