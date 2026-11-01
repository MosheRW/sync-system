import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionState } from '../src/state.js';
import { LIMITS, PARTICIPANT_ID, makeClient, serverHandshake } from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('connection state (AC24)', () => {
  it('goes idle -> connecting -> connected -> closed(client), with a state event per change', async () => {
    const client = makeClient();
    const states: ConnectionState[] = [];
    client.on('state', (state) => states.push(state));
    expect(client.getState()).toEqual({ status: 'idle' });

    const connecting = client.connect();
    expect(client.getState()).toEqual({ status: 'connecting' });
    serverHandshake(FakeWebSocket.last);
    await connecting;
    client.close();

    expect(states).toEqual([
      { status: 'connecting' },
      { status: 'connected', participantId: PARTICIPANT_ID, limits: LIMITS },
      { status: 'closed', reason: 'client' },
    ]);
    expect(client.getState()).toEqual({ status: 'closed', reason: 'client' });
  });

  it('reports closed(fatal) with the error', async () => {
    const client = makeClient();
    const connecting = client.connect().catch((error: unknown) => error);
    const socket = FakeWebSocket.last;
    socket.open();
    socket.receive({ type: 'welcome', protocolVersion: 1, minProtocolVersion: 1 });
    socket.receive({ type: 'error', reqId: 'c1', code: 'INVALID_API_KEY', message: 'x' });
    const error = await connecting;
    expect(client.getState()).toEqual({ status: 'closed', reason: 'fatal', error });
  });

  it('keeps the snapshot identity with no change and replaces it on a change', async () => {
    const client = makeClient();
    const first = client.getSnapshot();
    expect(client.getSnapshot()).toBe(first);
    expect(first).toEqual({ connection: { status: 'idle' }, group: null });
    expect(Object.isFrozen(first)).toBe(true);

    const connecting = client.connect();
    const second = client.getSnapshot();
    expect(second).not.toBe(first);
    expect(client.getSnapshot()).toBe(second);
    serverHandshake(FakeWebSocket.last);
    await connecting;
    expect(client.getSnapshot()).not.toBe(second);
    client.close();
  });

  it('notifies subscribers on each snapshot change, and stops after unsubscribe', async () => {
    const client = makeClient();
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    const connecting = client.connect();
    expect(listener).toHaveBeenCalledTimes(1);
    serverHandshake(FakeWebSocket.last);
    await connecting;
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    client.close();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('close() is idempotent and leaves no timers', async () => {
    const client = makeClient();
    const connecting = client.connect().catch(() => undefined);
    client.close();
    client.close();
    await connecting;
    expect(client.getState()).toEqual({ status: 'closed', reason: 'client' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
