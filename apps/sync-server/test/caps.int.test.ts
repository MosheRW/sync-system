import { afterEach, describe, expect, it } from 'vitest';
import { RawClient } from './helpers/raw-client.js';
import type { TestClient } from './helpers/test-client.js';
import { type TestServer, httpGet, startTestServer } from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

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
