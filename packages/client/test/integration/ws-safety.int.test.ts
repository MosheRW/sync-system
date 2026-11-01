import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket as WsWebSocket } from 'ws';
import type { WebSocketConstructorLike } from '../../src/host.js';
import { Transport } from '../../src/transport.js';
import { type BlackholeServer, startBlackholeServer } from '../helpers/blackhole-server.js';
import { waitUntil } from '../helpers/wait.js';

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
});
