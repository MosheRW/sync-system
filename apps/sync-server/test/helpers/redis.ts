import { randomBytes } from 'node:crypto';
import { createClient } from '@redis/client';
import { describe } from 'vitest';
import { type RedisSettings, parseRedisSettings } from '../../src/config/redis.js';
import { type Logger, createLogger } from '../../src/logging/logger.js';
import { type RedisLink, connectRedis } from '../../src/storage/redis/connect.js';

/**
 * The Redis the `*.redis.test.ts` suites run against (#35 AC29, AC31), e.g.
 * `redis://:ci-only-redis-password@127.0.0.1:6379`. Without it they are
 * skipped locally; `redis-required.test.ts` fails the run in CI.
 */
export const TEST_REDIS_URL = process.env.SYNC_TEST_REDIS_URL;

/** A suite that runs only when a test Redis is configured (else skipped). */
export function describeRedis(name: string, suite: () => void): void {
  describe.skipIf(TEST_REDIS_URL === undefined)(name, suite);
}

/** A fresh key prefix per test, so suites never see each other's keys (AC5). */
export function randomPrefix(): string {
  return `t${randomBytes(6).toString('hex')}`;
}

export function testRedisSettings(
  prefix: string,
  extra: Record<string, string> = {},
): RedisSettings {
  return parseRedisSettings({
    REDIS_URL: TEST_REDIS_URL!,
    REDIS_KEY_PREFIX: prefix,
    REDIS_CONNECT_TIMEOUT_SECONDS: '5',
    NODE_ENV: 'test',
    ...extra,
  })!;
}

const silent: Logger = createLogger({ level: 'silent' });

/** A connected link for `prefix` (the test fails if it cannot connect). */
export async function testLink(prefix: string, logger: Logger = silent): Promise<RedisLink> {
  const result = await connectRedis(testRedisSettings(prefix), { logger, nodeEnv: 'test' });
  if (!result.ok) throw new Error(`test redis: ${result.message}`);
  return result.link;
}

/** A raw client for inspecting keys and TTLs (tests only; SCAN by pattern is fine here). */
export async function inspector() {
  const client = createClient({ url: TEST_REDIS_URL!, RESP: 2, disableClientInfo: true });
  client.on('error', () => undefined);
  await client.connect();
  return {
    client,
    /** Every key under `prefix`. */
    async keys(prefix: string): Promise<string[]> {
      const found: string[] = [];
      for await (const batch of client.scanIterator({ MATCH: `${prefix}:*`, COUNT: 500 })) {
        found.push(...batch);
      }
      return found.sort();
    },
    /** Deletes every key under `prefix`. */
    async flush(prefix: string): Promise<void> {
      const keys = await this.keys(prefix);
      if (keys.length > 0) await client.unlink(keys);
    },
    close(): void {
      client.destroy();
    },
  };
}
