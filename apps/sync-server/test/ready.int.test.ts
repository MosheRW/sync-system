import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createHttpHandler } from '../src/http/health.js';
import { memoryStorage } from '../src/storage/storage.js';
import { realScheduler } from '../src/time/scheduler.js';
import { createLogger } from '../src/logging/logger.js';
import { LogCapture } from './helpers/log-capture.js';
import { type TestServer, httpGet, startTestServer } from './helpers/test-server.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

/** A request with any method; resolves with the status and the body text. */
function send(
  port: number,
  method: string,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Calls the handler directly and captures the response. */
function callHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  method: string,
  url: string,
): { status: number; body: string; headers: Record<string, unknown> } {
  const out = { status: 0, body: '', headers: {} as Record<string, unknown> };
  const res = {
    writeHead(status: number, headers: Record<string, unknown>) {
      out.status = status;
      out.headers = headers;
    },
    end(body: string) {
      out.body = body;
    },
  } as unknown as ServerResponse;
  handler({ method, url } as IncomingMessage, res);
  return out;
}

describe('GET /ready (#36 AC35)', () => {
  it('returns 200 ready with the storage kind and the /health headers', async () => {
    ts = await startTestServer();
    const kind = ts.server.storage().kind;
    for (const path of ['/ready', '/ready?probe=1']) {
      const res = await httpGet(ts.port, path);
      expect(res.status, path).toBe(200);
      expect(res.body).toEqual({ status: 'ready', storage: kind });
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('retry-after')).toBeNull();
    }
    expect(ts.server.ready()).toBe(true);
  });

  it('gives 404 for other methods and sub-paths', async () => {
    ts = await startTestServer();
    for (const method of ['POST', 'HEAD', 'PUT', 'DELETE']) {
      const res = await send(ts.port, method, '/ready');
      expect(res.status, method).toBe(404);
    }
    for (const path of ['/ready/x', '/readyz', '/READY']) {
      const res = await httpGet(ts.port, path);
      expect(res.status, path).toBe(404);
      expect(res.body).toEqual({ error: 'not_found' });
    }
  });

  it('returns 503 not_ready and refuses upgrades while the storage is unreachable', async () => {
    const logs = new LogCapture();
    const base = memoryStorage({
      scheduler: realScheduler(),
      logger: createLogger({ level: 'silent', destination: logs }),
    });
    let state: 'connected' | 'unreachable' = 'connected';
    const storage = {
      ...base,
      kind: 'redis' as const,
      status: () => ({ kind: 'redis' as const, state }),
    };
    ts = await startTestServer({ storage });
    expect((await httpGet(ts.port, '/ready')).body).toEqual({ status: 'ready', storage: 'redis' });

    state = 'unreachable';
    const res = await httpGet(ts.port, '/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'not_ready', storage: 'redis' });
    expect(ts.server.ready()).toBe(false);
    await expect(ts.connect()).rejects.toThrow();
    // Liveness stays up (#36 AC33).
    const health = await httpGet(ts.port, '/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: 'ok', version, storage: 'redis' });

    state = 'connected';
    expect((await httpGet(ts.port, '/ready')).status).toBe(200);
  });

  it('is not ready from the moment close() starts (Q22)', async () => {
    ts = await startTestServer();
    expect(ts.server.ready()).toBe(true);
    const closing = ts.server.close();
    expect(ts.server.ready()).toBe(false);
    await closing;
    ts = undefined;
  });
});

describe('createHttpHandler', () => {
  it('serves prebuilt bodies and reads ready() per request', () => {
    let ready = true;
    const handler = createHttpHandler({
      version: '9.9.9',
      storageKind: 'memory',
      ready: () => ready,
    });
    expect(callHandler(handler, 'GET', '/ready')).toMatchObject({
      status: 200,
      body: '{"status":"ready","storage":"memory"}',
    });
    ready = false;
    const notReady = callHandler(handler, 'GET', '/ready');
    expect(notReady).toMatchObject({
      status: 503,
      body: '{"status":"not_ready","storage":"memory"}',
    });
    expect(notReady.headers).toEqual({
      'Content-Type': 'application/json',
      'Content-Length': notReady.body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    // /health stays 200 while not ready (liveness).
    expect(callHandler(handler, 'GET', '/health')).toMatchObject({
      status: 200,
      body: '{"status":"ok","protocolVersion":1,"minProtocolVersion":1,"version":"9.9.9","storage":"memory"}',
    });
  });

  it('never calls ready() for /health or unknown paths', () => {
    let calls = 0;
    const handler = createHttpHandler({
      version: '1.0.0',
      storageKind: 'redis',
      ready: () => {
        calls += 1;
        return true;
      },
    });
    callHandler(handler, 'GET', '/health');
    callHandler(handler, 'GET', '/nope');
    callHandler(handler, 'POST', '/ready');
    expect(calls).toBe(0);
  });
});
