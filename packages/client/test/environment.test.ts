import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncClient } from '../src/client.js';
import { isSyncClientError } from '../src/errors.js';
import { TEST_API_KEY } from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';

const OPTIONS = { url: 'wss://sync.example.com/ws', apiKey: TEST_API_KEY, appVersion: '1.0.0' };

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('environment (AC4, AC6)', () => {
  it('uses the global WebSocket by default, read at connect time (AC4)', () => {
    const client = new SyncClient(OPTIONS);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    void client.connect().catch(() => {});
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.last.url).toBe('wss://sync.example.com/ws');
    client.close();
  });

  it('prefers the injected WebSocket (AC5)', () => {
    class Other extends FakeWebSocket {}
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const client = new SyncClient({ ...OPTIONS, WebSocket: Other });
    void client.connect().catch(() => {});
    expect(FakeWebSocket.last).toBeInstanceOf(Other);
    client.close();
  });

  it('without any WebSocket: the constructor works, connect() rejects NO_WEBSOCKET (AC6)', async () => {
    vi.stubGlobal('WebSocket', undefined);
    const client = new SyncClient(OPTIONS);
    let error: unknown;
    try {
      await client.connect();
    } catch (err) {
      error = err;
    }
    expect(error).not.toBeInstanceOf(ReferenceError);
    expect(isSyncClientError(error, 'NO_WEBSOCKET')).toBe(true);
    expect(client.getState()).toMatchObject({ status: 'closed', reason: 'fatal' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
