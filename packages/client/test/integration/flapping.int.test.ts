import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeClients, newClient } from '../helpers/int.js';
import { type RealServer, startRealServer } from '../helpers/real-server.js';
import { type TcpProxy, startTcpProxy } from '../helpers/tcp-proxy.js';
import { sleep } from '../helpers/wait.js';

let server: RealServer;
let proxy: TcpProxy;

beforeAll(async () => {
  server = await startRealServer();
  proxy = await startTcpProxy(server.port);
});

afterAll(async () => {
  closeClients();
  await proxy.close();
  await server.close();
});

describe('flapping server (H1)', () => {
  it('a server that drops every connection 100 ms after it opens gets growing delays', async () => {
    proxy.cutAfterMs = 100;
    // Default backoff; random 1 makes every delay equal to its cap (R2-L5).
    const { client } = newClient(proxy.url, {
      random: () => 1,
      reconnect: {},
    });
    const before = proxy.connections;
    void client.connect().catch(() => {});
    await sleep(3000);
    const attempts = proxy.connections - before;
    // 0.5 s, 1 s, 2 s caps: about 3 connections in 3 s. A client that reset
    // its backoff on every hello.ok would make about 5 with these delays.
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(attempts).toBeLessThanOrEqual(4);
    const state = client.getState();
    expect(state.status === 'reconnecting' && state.attempt).toBeGreaterThanOrEqual(2);
  });
});
