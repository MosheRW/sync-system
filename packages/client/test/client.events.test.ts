import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncClientError } from '../src/errors.js';
import type { ConnectionState } from '../src/state.js';
import { TEST_API_KEY, connectedClient, makeClient, serverHandshake } from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('events (AC19)', () => {
  it('on() returns an unsubscribe function, and off() removes a listener', async () => {
    const client = makeClient();
    const a = vi.fn();
    const b = vi.fn();
    const unsubscribe = client.on('state', a);
    client.on('state', b);
    unsubscribe();
    client.off('state', b);
    const connecting = client.connect();
    serverHandshake(FakeWebSocket.last);
    await connecting;
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    client.close();
  });

  it('skips a listener removed during an emit', async () => {
    const client = makeClient();
    const calls: string[] = [];
    let offSecond = () => {};
    client.on('state', () => {
      calls.push('first');
      offSecond();
    });
    offSecond = client.on('state', () => calls.push('second'));
    const connecting = client.connect();
    serverHandshake(FakeWebSocket.last);
    await connecting;
    expect(calls).toEqual(['first', 'first']);
    client.close();
  });

  it('a throwing listener breaks neither the other listeners nor the client; only its name is logged (L4)', async () => {
    const debug = vi.fn();
    const error = vi.fn();
    const client = makeClient({ logger: { debug, error } });
    const seen: ConnectionState[] = [];
    client.on('state', () => {
      throw new TypeError('APP-SECRET-DETAIL');
    });
    client.on('state', (state) => seen.push(state));
    const connecting = client.connect();
    serverHandshake(FakeWebSocket.last);
    await connecting;
    expect(seen.map((s) => s.status)).toEqual(['connecting', 'connected']);
    expect(error).toHaveBeenCalledWith('listener_error', { name: 'TypeError' });
    expect(JSON.stringify([debug.mock.calls, error.mock.calls])).not.toContain('APP-SECRET-DETAIL');
    client.close();
  });

  it('emits error events for server errors without a request', async () => {
    const { client, socket } = await connectedClient();
    const errors: SyncClientError[] = [];
    client.on('error', (e) => errors.push(e));
    socket.receive({ type: 'error', code: 'INTERNAL_ERROR', message: 'x' });
    expect(errors.map((e) => [e.code, e.source])).toEqual([['INTERNAL_ERROR', 'server']]);
    expect(client.getState().status).toBe('connected');
    client.close();
  });
});

describe('the API key stays private (L4)', () => {
  it('is not visible in JSON.stringify, Object.keys or util.inspect', async () => {
    const { client } = await connectedClient();
    expect(JSON.stringify(client)).not.toContain(TEST_API_KEY);
    expect(Object.keys(client)).toEqual([]);
    expect(inspect(client, { depth: 10, showHidden: true })).not.toContain(TEST_API_KEY);
    expect(JSON.stringify(client.getSnapshot())).not.toContain(TEST_API_KEY);
    client.close();
  });
});
