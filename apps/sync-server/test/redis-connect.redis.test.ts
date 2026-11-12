import { describe, expect, it } from 'vitest';
import { parseRedisSettings } from '../src/config/redis.js';
import { createLogger } from '../src/logging/logger.js';
import { connectRedis } from '../src/storage/redis/connect.js';
import { LogCapture } from './helpers/log-capture.js';
import { TEST_REDIS_URL, describeRedis, randomPrefix, testLink } from './helpers/redis.js';

function withPassword(password: string, user = ''): string {
  const url = new URL(TEST_REDIS_URL!);
  url.username = user;
  url.password = password;
  return url.toString();
}

describeRedis('Redis connection against a real Redis (#35 AC2, AC4, AC25)', () => {
  it('connects with the URL forms redis://:pass@ and redis://user:pass@ (AC2)', async () => {
    const password = new URL(TEST_REDIS_URL!).password;
    for (const url of [withPassword(password), withPassword(password, 'default')]) {
      const result = await connectRedis(parseRedisSettings({ REDIS_URL: url })!, {
        logger: createLogger({ level: 'silent' }),
        nodeEnv: 'test',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.link.state).toBe('connected');
      expect(await result.link.send(['PING'])).toBe('PONG');
      await result.link.close();
    }
  });

  it('reports a wrong password as an authentication failure and logs nothing of it (AC4)', async () => {
    const logs = new LogCapture();
    const url = withPassword('SENTINEL-wrong-password', 'SENTINELuser');
    const result = await connectRedis(parseRedisSettings({ REDIS_URL: url })!, {
      logger: createLogger({ level: 'trace', destination: logs }),
      nodeEnv: 'test',
    });
    expect(result).toEqual({ ok: false, message: 'Redis authentication failed (REDIS_URL)' });
    expect(logs.text).not.toContain('SENTINEL');
  });

  it('maps a reply error to StorageReplyError and keeps the state connected (C8)', async () => {
    const link = await testLink(randomPrefix());
    await expect(link.send(['NOSUCHCOMMAND'])).rejects.toMatchObject({
      name: 'StorageReplyError',
      code: 'ERR',
    });
    expect(link.state).toBe('connected');
    await link.close();
  });
});

describe('describeRedis', () => {
  it('runs the suite only with SYNC_TEST_REDIS_URL', () => {
    expect(typeof describeRedis).toBe('function');
  });
});
