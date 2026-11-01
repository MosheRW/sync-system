import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket as WsWebSocket } from 'ws';
import { SyncClient } from '../../src/client.js';
import type { WebSocketConstructorLike } from '../../src/host.js';
import { Transport } from '../../src/transport.js';
import { type BlackholeServer, startBlackholeServer } from '../helpers/blackhole-server.js';
import { sleep, waitUntil } from '../helpers/wait.js';

/**
 * H2: an injected `ws` socket must never emit an unhandled 'error'. Closing
 * a socket that is still CONNECTING makes `ws` emit 'error' on the next
 * tick; test/setup.ts fails this file on any uncaught exception.
 */
let blackhole: BlackholeServer;

beforeAll(async () => {
  blackhole = await startBlackholeServer();
});

afterAll(async () => {
  await blackhole.close();
});

const Ws: WebSocketConstructorLike = WsWebSocket;

describe('ws safety (H2)', () => {
  it('retiring a CONNECTING ws socket does not throw an unhandled error', async () => {
    const before = blackhole.connections;
    const handlers = { onOpen: vi.fn(), onFrame: vi.fn(), onClose: vi.fn() };
    const transport = new Transport(Ws, blackhole.url, handlers, 8192);
    await waitUntil(() => blackhole.connections > before, 2000, 'tcp connection');
    transport.retire(1000);
    // Give ws time to emit its 'error' and 'close' events.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(transport.retired).toBe(true);
  });

  it('retiring right after construction is safe too', async () => {
    const handlers = { onOpen: vi.fn(), onFrame: vi.fn(), onClose: vi.fn() };
    const transport = new Transport(Ws, blackhole.url, handlers, 8192);
    transport.retire(1000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it('a client whose attempt times out while CONNECTING keeps running and the process survives', async () => {
    const client = new SyncClient({
      url: blackhole.url,
      apiKey: 'test-api-key-ws-safety-0123456789-0123456789',
      appVersion: '1.0.0',
      WebSocket: Ws,
      requestTimeoutMs: 200,
      random: () => 0.5,
      reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
    });
    const errors: string[] = [];
    client.on('error', (e) => errors.push(e.code));
    const connecting = client.connect().catch(() => undefined);
    await waitUntil(() => errors.length >= 2, 3000, 'two attempt timeouts');
    expect(errors.slice(0, 2)).toEqual(['REQUEST_TIMEOUT', 'REQUEST_TIMEOUT']);
    client.close();
    await connecting;
    await sleep(200);
    expect(client.getState()).toEqual({ status: 'closed', reason: 'client' });
  });

  it('close() on a client that is still CONNECTING is safe', async () => {
    const client = new SyncClient({
      url: blackhole.url,
      apiKey: 'test-api-key-ws-safety-0123456789-0123456789',
      appVersion: '1.0.0',
      WebSocket: Ws,
    });
    const connecting = client.connect().catch(() => undefined);
    await sleep(50);
    client.close();
    await connecting;
    await sleep(200);
    expect(client.getState().status).toBe('closed');
  });
});
