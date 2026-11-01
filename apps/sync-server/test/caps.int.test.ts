import { afterEach, describe, expect, it } from 'vitest';
import { RawClient } from './helpers/raw-client.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, KEY_B, type TestServer, httpGet, startTestServer } from './helpers/test-server.js';
import { sleep, waitUntil } from './helpers/wait.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

const SMALL_CAPS = {
  MAX_CONNECTIONS: '3',
  MAX_APP_CONNECTIONS_CEILING: '3',
  MAX_PENDING_HANDSHAKES: '3',
};

describe('upgrade guard (H1, L4)', () => {
  it('sends welcome on a successful upgrade', async () => {
    ts = await startTestServer();
    const client = await ts.connect();
    expect(await client.next('welcome')).toEqual({
      type: 'welcome',
      protocolVersion: 1,
      minProtocolVersion: 1,
    });
  });

  it('answers 404 for any path other than /ws', async () => {
    ts = await startTestServer();
    for (const path of ['/', '/socket', '/ws/x', '/health']) {
      const result = await RawClient.upgrade(ts.port, { path });
      expect(result.status, path).toBe(404);
    }
    expect(ts.server.stats().total).toBe(0);
  });

  it('refuses the connection over MAX_CONNECTIONS with 503 and keeps /health up', async () => {
    ts = await startTestServer({ env: SMALL_CAPS });
    const clients: TestClient[] = [];
    for (let i = 0; i < 3; i++) clients.push(await ts.connect());
    expect(ts.server.stats().total).toBe(3);

    const refused = await RawClient.upgrade(ts.port);
    expect(refused.status).toBe(503);
    expect(ts.server.stats().total).toBe(3);

    const health = await httpGet(ts.port, '/health');
    expect(health.status).toBe(200);

    await clients[0]!.close();
    await waitUntil(() => ts!.server.stats().total === 2);
    const accepted = await RawClient.upgrade(ts.port);
    expect(accepted.status).toBe(101);
    accepted.client?.destroy();
  });

  it('refuses un-helloed sockets over MAX_PENDING_HANDSHAKES with 503', async () => {
    ts = await startTestServer({ env: { MAX_PENDING_HANDSHAKES: '2' } });
    await ts.connect();
    await ts.connect();
    expect(ts.server.stats().pending).toBe(2);
    const refused = await RawClient.upgrade(ts.port);
    expect(refused.status).toBe(503);
  });

  it('accepts a new socket once a pending one completes hello (H1)', async () => {
    ts = await startTestServer({ env: { MAX_PENDING_HANDSHAKES: '2' } });
    const first = await ts.connect();
    await ts.connect();
    expect((await RawClient.upgrade(ts.port)).status).toBe(503);

    expect((await first.hello({ apiKey: KEY_A })).type).toBe('hello.ok');
    expect(ts.server.stats()).toMatchObject({ total: 2, pending: 1, perApp: { 'app-a': 1 } });
    const accepted = await RawClient.upgrade(ts.port);
    expect(accepted.status).toBe(101);
    accepted.client?.destroy();
  });

  it('closes a socket that never sends hello with HANDSHAKE_TIMEOUT and 4002 (H1)', async () => {
    ts = await startTestServer({ handshakeTimeoutMs: 100 });
    const client = await ts.connect();
    await client.next('welcome');
    expect(await client.next('error', 1000)).toMatchObject({ code: 'HANDSHAKE_TIMEOUT' });
    expect(await client.closed()).toEqual({ code: 4002, reason: 'HANDSHAKE_TIMEOUT' });
    await waitUntil(() => ts!.server.stats().total === 0);
  });

  it('does not time out a socket that completed hello', async () => {
    ts = await startTestServer({ handshakeTimeoutMs: 100 });
    const client = await ts.connectReady();
    await sleep(250);
    expect(client.isClosed).toBe(false);
  });

  it('limits sockets per app with APP_CONNECTION_LIMIT and close 4003 (M5)', async () => {
    ts = await startTestServer({
      apps: [
        { namespace: 'app-a', apiKey: KEY_A, maxConnections: 2 },
        { namespace: 'app-b', apiKey: KEY_B },
      ],
    });
    const first = await ts.connectReady(KEY_A);
    await ts.connectReady(KEY_A);

    const third = await ts.connect();
    expect(await third.hello({ apiKey: KEY_A })).toMatchObject({
      type: 'error',
      code: 'APP_CONNECTION_LIMIT',
    });
    expect(await third.closed()).toEqual({ code: 4003, reason: 'APP_CONNECTION_LIMIT' });

    // Another app is unaffected.
    await ts.connectReady(KEY_B);

    await first.close();
    await waitUntil(() => ts!.server.stats().perApp['app-a'] === 1);
    await ts.connectReady(KEY_A);
  });

  it('returns the counters to 0 after clean and abrupt closes', async () => {
    ts = await startTestServer({ env: SMALL_CAPS });
    const clean = await ts.connect();
    const raw = await RawClient.connect(ts.port);
    const terminated = await ts.connect();
    await waitUntil(() => ts!.server.stats().total === 3);

    await clean.close();
    raw.destroy();
    terminated.terminate();

    await waitUntil(() => ts!.server.stats().total === 0, 2000, 'counters to drop');
    expect(ts.server.stats()).toEqual({ total: 0, pending: 0, perApp: {} });
  });

  it('never negotiates permessage-deflate (L4)', async () => {
    ts = await startTestServer();
    const client = await RawClient.connect(ts.port, {
      headers: { 'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits' },
    });
    expect(client.responseHead.toLowerCase()).not.toContain('sec-websocket-extensions');
    client.destroy();
  });
});

describe('close timeout (S1)', () => {
  /** Waits for the server to drop the socket; returns how long that took. */
  async function slotFreedWithin(): Promise<number> {
    const started = Date.now();
    await waitUntil(() => ts!.server.stats().total === 0, 4000, 'slot to be freed');
    expect(ts!.server.stats()).toEqual({ total: 0, pending: 0, perApp: {} });
    return Date.now() - started;
  }

  it('frees a pending slot within ~2 s when the peer never answers the close', async () => {
    ts = await startTestServer({ handshakeTimeoutMs: 100 });
    const raw = await RawClient.connect(ts.port);
    raw.ignoreClose = true;
    await waitUntil(() => raw.closeCode === 4002, 1000, 'handshake timeout close');
    expect(ts.server.stats().pending).toBe(1);
    expect(await slotFreedWithin()).toBeLessThan(3000);
    raw.destroy();
  });

  it('frees an app slot within ~2 s when the peer never answers the close', async () => {
    ts = await startTestServer();
    const raw = await RawClient.connect(ts.port);
    raw.ignoreClose = true;
    raw.sendJson({ type: 'hello', protocolVersion: 1, appVersion: '1.0.0', apiKey: KEY_A });
    await raw.waitForType('hello.ok');
    // Over the default burst of 40: the server closes with 4008.
    for (let i = 0; i < 60; i++) raw.sendText('{}');
    await waitUntil(() => raw.closeCode === 4008, 1000, 'flood close');
    expect(ts.server.stats().perApp).toEqual({ 'app-a': 1 });
    expect(await slotFreedWithin()).toBeLessThan(3000);
    raw.destroy();
  });
});
