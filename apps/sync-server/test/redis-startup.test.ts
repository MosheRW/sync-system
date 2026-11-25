import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { type AddressInfo, type Server, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer } from 'node:tls';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseRedisSettings } from '../src/config/redis.js';
import { createLogger } from '../src/logging/logger.js';
import { connectRedis } from '../src/storage/redis/connect.js';
import { LogCapture } from './helpers/log-capture.js';

const USER = 'SENTINELuser';
const PASSWORD = 'SENTINEL-pass';

const servers: Server[] = [];
const sockets = new Set<{ destroy(): void }>();
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

async function attempt(url: string, seconds = '2') {
  const logs = new LogCapture();
  const settings = parseRedisSettings({ REDIS_URL: url, REDIS_CONNECT_TIMEOUT_SECONDS: seconds })!;
  const result = await connectRedis(settings, {
    logger: createLogger({ level: 'trace', destination: logs }),
    nodeEnv: 'test',
  });
  expect(logs.text).not.toContain(PASSWORD);
  expect(logs.text).not.toContain(USER);
  if (result.ok) await result.link.close();
  return result;
}

/**
 * A self-signed certificate for localhost, made with the openssl CLI. The
 * key is read into memory and its temp directory removed at once (L3).
 */
function selfSigned(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'sync-tls-'));
  try {
    return makeCertificate(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeCertificate(dir: string): { key: Buffer; cert: Buffer } {
  const run = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  if (run.status !== 0) throw new Error('openssl is required for the TLS test');
  return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
}

describe('Redis startup errors without a Redis (#35 AC4, security C9, C10)', () => {
  // connectRedis loads @redis/client lazily (ADR 0010). Warm that import so
  // the timed assertions below measure the connect, not the module load,
  // which is slow under the parallel full run (#78).
  beforeAll(async () => {
    await import('@redis/client');
  }, 60_000);

  it('reports a refused port as unreachable, fast', async () => {
    const port = await listen(createServer());
    servers.pop()!.close();
    const started = Date.now();
    const result = await attempt(`redis://${USER}:${PASSWORD}@127.0.0.1:${port}`, '10');
    expect(result).toEqual({ ok: false, message: 'Redis is unreachable (REDIS_URL)' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reports a black-hole address as unreachable within the connect timeout', async () => {
    const started = Date.now();
    const result = await attempt(`redis://${USER}:${PASSWORD}@10.255.255.1:6379`, '1');
    expect(result).toEqual({ ok: false, message: 'Redis is unreachable (REDIS_URL)' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('reports TLS against a plain (non-TLS) port as a TLS failure', async () => {
    const port = await listen(
      createServer((socket) => {
        socket.on('error', () => undefined);
        socket.end('-ERR not tls\r\n');
      }),
    );
    const result = await attempt(`rediss://${USER}:${PASSWORD}@localhost:${port}`);
    expect(result).toEqual({ ok: false, message: 'Redis TLS handshake failed (REDIS_URL)' });
  });

  it('refuses a self-signed certificate: verification cannot be turned off (C10)', async () => {
    const server = createTlsServer(selfSigned(), (socket) => {
      socket.on('error', () => undefined);
      socket.end('+PONG\r\n');
    });
    server.on('tlsClientError', () => undefined);
    const port = await listen(server);
    const result = await attempt(`rediss://${USER}:${PASSWORD}@localhost:${port}`);
    expect(result).toEqual({ ok: false, message: 'Redis TLS handshake failed (REDIS_URL)' });
  }, 30_000);
});
