// @vitest-environment node
import { connect } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClientErrorHandler } from '../server/client-error.js';
import { securityHeaders } from '../server/headers.js';
import { run } from '../server/run.js';
import { makeDist, rawRequest } from './helpers/server.js';

const dist = makeDist();
let port = 0;
let close: () => Promise<void> = () => Promise.resolve();

beforeAll(async () => {
  const result = await run(
    { PORT: '0', HOST: '127.0.0.1' },
    {
      distDir: dist.dir,
      stdout: () => undefined,
      stderr: () => undefined,
      timeouts: { headersMs: 200, requestMs: 400, checkIntervalMs: 50 },
    },
  );
  if (!result.ok) throw new Error('server did not start');
  port = result.port;
  close = result.close;
});

afterAll(async () => {
  await close();
  dist.cleanup();
});

/** Opens a socket, sends `payload` (maybe nothing) and never ends it; resolves when the server closes it. */
function waitForServerClose(payload: string): Promise<{ data: string; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const socket = connect(port, '127.0.0.1');
    let data = '';
    const guard = setTimeout(() => {
      socket.destroy();
      reject(new Error('server kept the connection open'));
    }, 5_000);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (data += chunk));
    socket.on('close', () => {
      clearTimeout(guard);
      resolve({ data, ms: Date.now() - started });
    });
    socket.on('error', () => undefined);
    if (payload) socket.write(payload);
  });
}

async function healthStatus(): Promise<number> {
  return (await fetch(`http://127.0.0.1:${port}/health`)).status;
}

describe('request timeouts are not answered with 400 (QA N7, security C1)', () => {
  it('closes an idle connection that sent nothing without a response', async () => {
    const { data } = await waitForServerClose('');
    expect(data).toBe('');
    expect(await healthStatus()).toBe(200);
  });

  it('answers a request whose headers never finish with 408 and the security headers', async () => {
    const { data } = await waitForServerClose('GET / HTTP/1.1\r\nHost: x\r\n');
    expect(data).toMatch(/^HTTP\/1\.1 408 Request Timeout\r\n/);
    expect(data).not.toContain(' 400 ');
    expect(data.toLowerCase()).toContain('connection: close');
    expect(data.toLowerCase()).toContain('content-security-policy:');
    expect(await healthStatus()).toBe(200);
  });

  it('still answers unparseable requests with 400 and the security headers', async () => {
    const response = await rawRequest(port, 'NOT HTTP AT ALL\r\n\r\n');
    expect(response).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/);
    expect(response.toLowerCase()).toContain('content-security-policy:');
    expect(await healthStatus()).toBe(200);
  });
});

describe('createClientErrorHandler never throws', () => {
  const handle = createClientErrorHandler(securityHeaders([]));
  const parseError = Object.assign(new Error('Parse Error'), { code: 'HPE_INVALID_METHOD' });

  it('destroys a socket that is no longer writable', () => {
    const socket = new PassThrough();
    socket.end();
    expect(socket.writable).toBe(false);
    expect(() => handle(parseError, socket)).not.toThrow();
    expect(socket.destroyed).toBe(true);
  });

  it('destroys the socket when writing the response throws', () => {
    const socket = new PassThrough();
    socket.on('error', () => undefined);
    socket.end = () => {
      throw new Error('write after end');
    };
    expect(() => handle(parseError, socket)).not.toThrow();
    expect(socket.destroyed).toBe(true);
  });
});
