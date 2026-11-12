import { describe, expect, it } from 'vitest';
import { parseRedisSettings } from '../src/config/redis.js';
import { createLogger } from '../src/logging/logger.js';
import { StorageReplyError, StorageUnavailableError } from '../src/storage/errors.js';
import {
  connectRedis,
  infoField,
  isUnavailable,
  reconnectDelay,
  replyCode,
  startupMessage,
} from '../src/storage/redis/connect.js';
import { LogCapture } from './helpers/log-capture.js';

class ErrorReply extends Error {}
class SimpleError extends ErrorReply {}
class ConnectionTimeoutError extends Error {}
class SocketClosedUnexpectedlyError extends Error {}

function errno(code: string): Error {
  return Object.assign(new Error('connect failed sentinel-host.example:6390'), { code });
}

/** A stand-in client module: connect succeeds and INFO answers from `info`. */
function fakeModule(info: Record<string, string>, calls: string[][] = []) {
  return () =>
    Promise.resolve({
      createClient: (options: unknown) => {
        calls.push(['createClient', JSON.stringify(options)]);
        return {
          isOpen: true,
          on: () => undefined,
          connect: () => Promise.resolve(),
          sendCommand: (args: string[]) => {
            calls.push(args);
            if (args[0] === 'INFO') return Promise.resolve(info[args[1]!] ?? '');
            return Promise.resolve('PONG');
          },
          close: () => Promise.resolve(),
          destroy: () => undefined,
        };
      },
    } as never);
}

const SETTINGS = parseRedisSettings({
  REDIS_URL: 'rediss://SENTINELuser:SENTINEL-pw@sentinel-host.example:6390/3',
})!;

describe('Redis connection (#35 AC4, AC25, ADR 0014)', () => {
  it('classifies startup failures from the error code only (AC4)', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH']) {
      expect(startupMessage(errno(code))).toBe('Redis is unreachable (REDIS_URL)');
    }
    expect(startupMessage(new ConnectionTimeoutError())).toBe('Redis is unreachable (REDIS_URL)');
    for (const word of ['WRONGPASS', 'NOAUTH', 'NOPERM']) {
      expect(startupMessage(new SimpleError(`${word} sentinel`))).toBe(
        'Redis authentication failed (REDIS_URL)',
      );
    }
    for (const code of [
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'ERR_SSL_WRONG_VERSION_NUMBER',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'CERT_HAS_EXPIRED',
      'EPROTO',
    ]) {
      expect(startupMessage(errno(code))).toBe('Redis TLS handshake failed (REDIS_URL)');
    }
    expect(startupMessage(new Error('sentinel-host.example'))).toBe(
      'Redis connection failed (REDIS_URL)',
    );
  });

  it('treats only connection errors, timeouts and transient replies as unavailable (C8)', () => {
    for (const word of ['LOADING', 'READONLY', 'MASTERDOWN', 'BUSY', 'OOM', 'TRYAGAIN']) {
      expect(isUnavailable(new SimpleError(`${word} x`))).toBe(true);
    }
    expect(isUnavailable(new SocketClosedUnexpectedlyError())).toBe(true);
    expect(isUnavailable(errno('ECONNRESET'))).toBe(true);
    expect(isUnavailable(new StorageUnavailableError())).toBe(true);
    for (const reply of ['ERR syntax', 'WRONGTYPE x', 'NOSCRIPT x', 'ERR Error running script']) {
      expect(isUnavailable(new SimpleError(reply))).toBe(false);
    }
    expect(isUnavailable(new TypeError('bug'))).toBe(false);
    expect(replyCode(new SimpleError('WRONGTYPE Operation'))).toBe('WRONGTYPE');
    expect(replyCode(new Error('WRONGTYPE'))).toBeUndefined();
  });

  it('backs off exponentially up to 5 s with jitter', () => {
    expect(reconnectDelay(0, () => 1)).toBe(100);
    expect(reconnectDelay(3, () => 1)).toBe(800);
    expect(reconnectDelay(10, () => 1)).toBe(5000);
    expect(reconnectDelay(10, () => 0)).toBe(4000);
    expect(reconnectDelay(1000, () => 0.5)).toBe(4500);
  });

  it('reads INFO fields', () => {
    const info = '# Server\r\nredis_version:7.2.17\r\nredis_mode:standalone\r\n';
    expect(infoField(info, 'redis_version')).toBe('7.2.17');
    expect(infoField(info, 'missing')).toBeUndefined();
  });

  it('refuses a server older than 7.2 (AC4)', async () => {
    const result = await connectRedis(SETTINGS, {
      logger: createLogger({ level: 'silent' }),
      nodeEnv: 'test',
      importClient: fakeModule({ server: 'redis_version:7.0.15\r\n' }),
    });
    expect(result).toEqual({ ok: false, message: 'Redis 7.2 or later is required' });
  });

  it('accepts Valkey 7.2 and Redis 8', async () => {
    for (const server of ['redis_version:7.2.4\r\nvalkey_version:8.0.1', 'redis_version:8.2.0']) {
      const result = await connectRedis(SETTINGS, {
        logger: createLogger({ level: 'silent' }),
        nodeEnv: 'test',
        importClient: fakeModule({ server, memory: 'maxmemory_policy:noeviction' }),
      });
      expect(result.ok).toBe(true);
      if (result.ok) await result.link.close();
    }
  });

  it('verifies TLS with the host name and passes no URL (C10)', async () => {
    const calls: string[][] = [];
    const result = await connectRedis(SETTINGS, {
      logger: createLogger({ level: 'silent' }),
      nodeEnv: 'test',
      importClient: fakeModule(
        { server: 'redis_version:7.2.17', memory: 'maxmemory_policy:noeviction' },
        calls,
      ),
    });
    expect(result.ok).toBe(true);
    const options = JSON.parse(calls[0]![1]!) as Record<string, Record<string, unknown>>;
    expect(options.socket).toMatchObject({
      host: 'sentinel-host.example',
      port: 6390,
      tls: true,
      servername: 'sentinel-host.example',
    });
    expect(options.socket).not.toHaveProperty('rejectUnauthorized');
    expect(options).not.toHaveProperty('url');
    expect(options).toMatchObject({ database: 3, disableOfflineQueue: true });
  });

  it('warns about an eviction policy other than noeviction and a missing password (C2)', async () => {
    const logs = new LogCapture();
    const noPassword = parseRedisSettings({ REDIS_URL: 'redis://sentinel-host.example' })!;
    const result = await connectRedis(noPassword, {
      logger: createLogger({ level: 'info', destination: logs }),
      nodeEnv: 'production',
      importClient: fakeModule({
        server: 'redis_version:7.2.17',
        memory: 'maxmemory_policy:allkeys-lru',
      }),
    });
    expect(result.ok).toBe(true);
    const eviction = logs.find('redis_eviction_policy');
    expect(eviction).toMatchObject({ level: 40, policy: 'allkeys-lru' });
    expect(String(eviction?.msg)).toContain('ended group may then be recreated');
    expect(logs.find('redis_no_password')).toBeDefined();
    expect(logs.text).not.toContain('sentinel-host');
    if (result.ok) await result.link.close();
  });

  it('wraps reply errors without their text', () => {
    const err = new StorageReplyError('WRONGTYPE');
    expect(err.message).toBe('storage reply error');
    expect(err.code).toBe('WRONGTYPE');
  });
});
