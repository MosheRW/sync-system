import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncClient } from '../src/client.js';
import { isSyncClientError } from '../src/errors.js';
import { PARTICIPANT_ID, connectedClient, makeClient, serverHandshake } from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';

const GROUP_ID = 'G'.repeat(43);
const HOUR = 3_600_000;

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

/** Plays a fatal INVALID_API_KEY on the newest socket. */
function rejectKey(): void {
  const socket = FakeWebSocket.last;
  socket.open();
  socket.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
  socket.receive({
    type: 'error',
    reqId: socket.lastMessage().reqId,
    code: 'INVALID_API_KEY',
    message: 'x',
  });
}

describe('close() (AC28)', () => {
  it('during connecting: closes the socket with 1000, rejects connect() with CLOSED, leaves no timers', async () => {
    const client = makeClient();
    const connecting = client.connect();
    const socket = FakeWebSocket.last;
    client.close();
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: undefined }]);
    expect(isSyncClientError(await rejection(connecting), 'CLOSED')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(HOUR);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('while connected with a pending request and a throttled update', async () => {
    const { client, socket } = await connectedClient();
    const creating = client.createGroup({});
    socket.receive({
      type: 'group.created',
      token: 'h.p.s',
      reqId: socket.lastMessage().reqId,
      groupId: GROUP_ID,
      participantId: PARTICIPANT_ID,
      role: 'leader',
    });
    await creating;
    for (let i = 0; i < 10; i += 1) client.updatePosition(i);
    const sentBefore = socket.sent.length;
    client.close();
    expect(socket.closeCalls).toEqual([{ code: 1000, reason: undefined }]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(HOUR);
    expect(socket.sent).toHaveLength(sentBefore);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('rejects a pending create/join with CLOSED', async () => {
    const { client } = await connectedClient();
    const joining = client.joinGroup(GROUP_ID);
    client.close();
    expect(isSyncClientError(await rejection(joining), 'CLOSED')).toBe(true);
  });

  it('while reconnecting: cancels the reconnect timer for good', async () => {
    const { client, socket } = await connectedClient();
    socket.serverClose(1006);
    expect(client.getState().status).toBe('reconnecting');
    client.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(HOUR);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.getState()).toEqual({ status: 'closed', reason: 'client' });
  });
});

describe('close() from a listener inside an internal flow (AC28)', () => {
  async function leaderClient(): Promise<{ client: SyncClient; socket: FakeWebSocket }> {
    const { client, socket } = await connectedClient();
    const creating = client.createGroup({});
    socket.receive({
      type: 'group.created',
      token: 'h.p.s',
      reqId: socket.lastMessage().reqId,
      groupId: GROUP_ID,
      participantId: PARTICIPANT_ID,
      role: 'leader',
    });
    await creating;
    return { client, socket };
  }

  async function memberClient(): Promise<{ client: SyncClient; socket: FakeWebSocket }> {
    const { client, socket } = await connectedClient();
    const joining = client.joinGroup(GROUP_ID);
    socket.receive({
      type: 'group.joined',
      token: 'h.p.s',
      leaderOnline: true,
      reqId: socket.lastMessage().reqId,
      groupId: GROUP_ID,
      participantId: PARTICIPANT_ID,
      role: 'member',
      metadata: {},
      hasPosition: false,
    });
    await joining;
    return { client, socket };
  }

  /** closed(client), no timer left, and no socket opened even an hour later. */
  function expectClosedForGood(client: SyncClient, sockets: number): void {
    expect(client.getState()).toEqual({ status: 'closed', reason: 'client' });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(HOUR);
    expect(FakeWebSocket.instances).toHaveLength(sockets);
    expect(client.getState()).toEqual({ status: 'closed', reason: 'client' });
  }

  it('subscribe listener during a leader drop (group -> rejoining, #5 AC35)', async () => {
    const { client, socket } = await leaderClient();
    const errors: string[] = [];
    client.on('error', (error) => errors.push(error.code));
    client.subscribe(() => client.close());
    socket.serverClose(1006);
    expectClosedForGood(client, 1);
    expect(errors).toEqual([]);
  });

  it('subscribe listener during a member drop (group -> rejoining)', async () => {
    const { client, socket } = await memberClient();
    client.subscribe(() => client.close());
    socket.serverClose(1006);
    expectClosedForGood(client, 1);
  });

  it('state listener on reconnecting during a drop', async () => {
    const { client, socket } = await connectedClient();
    client.on('state', (state) => {
      if (state.status === 'reconnecting') client.close();
    });
    socket.serverClose(1006);
    expectClosedForGood(client, 1);
  });

  it('state listener on the retry attempt (attempting: true) opens no socket', async () => {
    const { client, socket } = await connectedClient();
    socket.serverClose(1006);
    client.on('state', (state) => {
      if (state.status === 'reconnecting' && state.attempting) client.close();
    });
    vi.advanceTimersToNextTimer();
    expectClosedForGood(client, 1);
  });

  it('state listener on connecting, with and without the R2-L6 gap', async () => {
    const client = makeClient();
    const stop = client.on('state', (state) => {
      if (state.status === 'connecting') client.close();
    });
    await rejection(client.connect());
    expectClosedForGood(client, 0);
    stop();

    const connected = await connectedClient();
    connected.client.close();
    connected.client.on('state', (state) => {
      if (state.status === 'connecting') connected.client.close();
    });
    // Inside initialDelayMs of the last socket: the open waits on a timer.
    await rejection(connected.client.connect());
    expectClosedForGood(connected.client, 1);
  });

  it('groupEnded listener during a fatal error (rejoining member, INVALID_API_KEY)', async () => {
    const { client, socket } = await memberClient();
    socket.serverClose(1006);
    vi.advanceTimersToNextTimer();
    const ended: string[] = [];
    client.on('groupEnded', (info) => {
      ended.push(info.reason);
      client.close();
    });
    rejectKey();
    expect(ended).toEqual(['rejoin_failed']);
    expectClosedForGood(client, 2);
  });
});

describe('connect() promise ownership when a listener calls connect() or close()', () => {
  /** Settles to 'resolved', or the error code, or 'pending' if still open after a microtask flush. */
  async function outcome(promise: Promise<unknown>): Promise<string> {
    let result = 'pending';
    promise.then(
      () => (result = 'resolved'),
      (error: unknown) => (result = isSyncClientError(error) ? error.code : 'other'),
    );
    await vi.advanceTimersByTimeAsync(0);
    return result;
  }

  it('close(): the old run rejects with CLOSED, the new run settles on its own outcome', async () => {
    const client = makeClient();
    const first = client.connect();
    let second: Promise<unknown> | undefined;
    client.on('state', (state) => {
      if (state.status === 'closed') second ??= client.connect();
    });
    client.close();
    expect(await outcome(first)).toBe('CLOSED');
    expect(second).toBeDefined();
    expect(await outcome(second!)).toBe('pending');
    vi.advanceTimersByTime(500);
    serverHandshake(FakeWebSocket.last);
    expect(await outcome(second!)).toBe('resolved');
    client.close();
  });

  it('fatal error: the old run rejects with the fatal code, the new run stays pending', async () => {
    const client = makeClient();
    const first = client.connect();
    let second: Promise<unknown> | undefined;
    client.on('state', (state) => {
      if (state.status === 'closed') second ??= client.connect();
    });
    rejectKey();
    expect(await outcome(first)).toBe('INVALID_API_KEY');
    expect(client.getState().status).toBe('reconnecting');
    expect(await outcome(second!)).toBe('pending');
    vi.advanceTimersToNextTimer();
    serverHandshake(FakeWebSocket.last);
    expect(await outcome(second!)).toBe('resolved');
    client.close();
  });

  it('gave up: the old run rejects with RECONNECT_FAILED, the new run stays pending', async () => {
    const client = makeClient({ reconnect: { maxAttempts: 1 } });
    const first = client.connect();
    let second: Promise<unknown> | undefined;
    client.on('state', (state) => {
      if (state.status === 'closed') second ??= client.connect();
    });
    FakeWebSocket.last.serverClose(1006);
    vi.advanceTimersToNextTimer();
    FakeWebSocket.last.serverClose(1006);
    expect(await outcome(first)).toBe('RECONNECT_FAILED');
    expect(await outcome(second!)).toBe('pending');
    client.close();
    expect(await outcome(second!)).toBe('CLOSED');
  });

  it('hello.ok: close() from a connected listener still resolves the run that connected', async () => {
    const client = makeClient();
    const first = client.connect();
    client.on('state', (state) => {
      if (state.status === 'connected') client.close();
    });
    serverHandshake(FakeWebSocket.last);
    expect(await outcome(first)).toBe('resolved');
    expect(client.getState()).toEqual({ status: 'closed', reason: 'client' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('connect() after a fatal or gave-up close (M5)', () => {
  it('20 connect() calls inside 1 s after INVALID_API_KEY open at most 1 socket', async () => {
    const client = makeClient();
    const first = client.connect().catch(() => undefined);
    rejectKey();
    await first;
    const before = FakeWebSocket.instances.length;
    for (let i = 0; i < 20; i += 1) {
      void client.connect().catch(() => undefined);
      if (FakeWebSocket.instances.length > before) rejectKey();
      vi.advanceTimersByTime(50);
    }
    expect(FakeWebSocket.instances.length - before).toBeLessThanOrEqual(1);
    client.close();
  });

  it('goes to reconnecting with the next backoff delay instead of opening a socket', async () => {
    const client = makeClient();
    const first = client.connect().catch(() => undefined);
    rejectKey();
    await first;
    void client.connect().catch(() => undefined);
    // One fatal failure: streak 1, so the wait uses the cap for failure 2.
    expect(client.getState()).toMatchObject({ status: 'reconnecting', attempt: 1, delayMs: 1000 });
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    serverHandshake(FakeWebSocket.last);
    expect(client.getState().status).toBe('connected');
    client.close();
  });

  it('waits after closed(gave_up) too', async () => {
    const client = makeClient({ reconnect: { maxAttempts: 1 } });
    const first = client.connect().catch(() => undefined);
    FakeWebSocket.last.serverClose(1006);
    vi.advanceTimersByTime(500);
    FakeWebSocket.last.serverClose(1006);
    await first;
    expect(client.getState()).toMatchObject({ status: 'closed', reason: 'gave_up' });
    const before = FakeWebSocket.instances.length;
    void client.connect().catch(() => undefined);
    expect(client.getState().status).toBe('reconnecting');
    expect(FakeWebSocket.instances).toHaveLength(before);
    client.close();
  });

  it('connects at once after close() with no failures', async () => {
    const { client } = await connectedClient();
    vi.advanceTimersByTime(10_000);
    client.close();
    void client.connect().catch(() => undefined);
    expect(client.getState().status).toBe('connecting');
    expect(FakeWebSocket.instances).toHaveLength(2);
    client.close();
  });

  it('keeps initialDelayMs between sockets for close() + connect() loops (R2-L6)', async () => {
    const { client } = await connectedClient();
    const before = FakeWebSocket.instances.length;
    for (let i = 0; i < 10; i += 1) {
      client.close();
      void client.connect().catch(() => undefined);
      vi.advanceTimersByTime(10);
    }
    expect(FakeWebSocket.instances).toHaveLength(before);
    expect(client.getState().status).toBe('connecting');
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(before + 1);
    client.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets the group to null on connect() from closed', async () => {
    const { client } = await connectedClient();
    const joining = client.joinGroup(GROUP_ID);
    client.close();
    await rejection(joining);
    vi.advanceTimersByTime(1000);
    void client.connect().catch(() => undefined);
    expect(client.getSnapshot().group).toBeNull();
    client.close();
  });
});

describe('no unhandled rejections inside the client (L6)', () => {
  async function scenario(run: (client: SyncClient) => Promise<void>): Promise<void> {
    const client = makeClient({ reconnect: { maxAttempts: 1 } });
    await run(client);
    client.close();
    // Let any stray rejection surface before test/setup.ts checks.
    await vi.advanceTimersByTimeAsync(0);
  }

  it('fatal error, gave-up, close during connect and rejoin failure, with only connect() caught', async () => {
    await scenario(async (client) => {
      const p = client.connect().catch(() => undefined);
      rejectKey();
      await p;
    });
    await scenario(async (client) => {
      const p = client.connect().catch(() => undefined);
      FakeWebSocket.last.serverClose(1006);
      await vi.advanceTimersByTimeAsync(500);
      FakeWebSocket.last.serverClose(1006);
      await p;
    });
    await scenario(async (client) => {
      const p = client.connect().catch(() => undefined);
      client.close();
      await p;
    });
    await scenario(async (client) => {
      const p = client.connect().catch(() => undefined);
      serverHandshake(FakeWebSocket.last);
      await p;
      const joining = client.joinGroup(GROUP_ID).catch(() => undefined);
      FakeWebSocket.last.receive({
        type: 'group.joined',
        token: 'h.p.s',
        leaderOnline: true,
        reqId: FakeWebSocket.last.lastMessage().reqId,
        groupId: GROUP_ID,
        participantId: PARTICIPANT_ID,
        role: 'member',
        metadata: {},
        hasPosition: false,
      });
      await joining;
      FakeWebSocket.last.serverClose(1006);
      await vi.advanceTimersByTimeAsync(500);
      serverHandshake(FakeWebSocket.last);
      FakeWebSocket.last.receive({
        type: 'error',
        reqId: FakeWebSocket.last.lastMessage().reqId,
        code: 'GROUP_NOT_FOUND',
        message: 'x',
      });
    });
  });
});
