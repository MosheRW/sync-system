import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestServer, httpGet, startTestServer } from './helpers/test-server.js';

let ts: TestServer;

beforeAll(async () => {
  ts = await startTestServer();
});

afterAll(async () => {
  await ts.close();
});

describe('HTTP', () => {
  it('GET /health returns 200 with status and versions only (AC23)', async () => {
    const res = await httpGet(ts.port, '/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.body).toEqual({ status: 'ok', protocolVersion: 1, minProtocolVersion: 1 });
  });

  it('ignores a query string on /health', async () => {
    const res = await httpGet(ts.port, '/health?x=1');
    expect(res.status).toBe(200);
  });

  it('returns 404 JSON for every other path, including listings (AC20)', async () => {
    for (const path of ['/', '/groups', '/apps', '/health/x', '/ws/groups', '/metrics']) {
      const res = await httpGet(ts.port, path);
      expect(res.status, path).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    }
  });

  it('returns 404 for other methods on /health', async () => {
    const res = await fetch(`http://127.0.0.1:${ts.port}/health`, { method: 'POST' });
    expect(res.status).toBe(404);
    await res.text();
  });

  it('sets slowloris timeouts and a socket backstop (H1)', () => {
    expect(ts.server.httpServer.headersTimeout).toBe(10_000);
    expect(ts.server.httpServer.requestTimeout).toBe(15_000);
    expect(ts.server.httpServer.maxConnections).toBe(10_000 + 64);
  });
});
