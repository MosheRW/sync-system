import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const serverDir = fileURLToPath(new URL('..', import.meta.url));

/**
 * In a fresh process, records every module specifier resolved while a
 * memory server starts and stops, then while a Redis connection is tried.
 */
const SCRIPT = `
import { registerHooks } from 'node:module';
const seen = new Set();
registerHooks({ resolve(s, c, n) { seen.add(s); return n(s, c); } });
const { randomBytes } = await import('node:crypto');
const { createSyncServer } = await import('./src/server.ts');
const { AppRegistry } = await import('./src/apps/app-registry.ts');
const { parseEnv } = await import('./src/config/env.ts');
const { createLogger } = await import('./src/logging/logger.ts');
const server = createSyncServer({
  env: parseEnv({}),
  registry: new AppRegistry([]),
  logger: createLogger({ level: 'silent' }),
  tokenSecrets: { current: randomBytes(32), source: 'random' },
});
await server.listen(0, '127.0.0.1');
const memory = server.storage();
await server.close();
const afterMemory = seen.has('@redis/client');
const { connectRedis } = await import('./src/storage/redis/connect.ts');
const { parseRedisSettings } = await import('./src/config/redis.ts');
await connectRedis(parseRedisSettings({ REDIS_URL: 'redis://127.0.0.1:1', REDIS_CONNECT_TIMEOUT_SECONDS: '1' }), {
  logger: createLogger({ level: 'silent' }),
  nodeEnv: 'test',
});
console.log(JSON.stringify({ memory, afterMemory, afterRedis: seen.has('@redis/client') }));
`;

describe('@redis/client is loaded only when Redis is configured (#35 AC1, AC28, ADR 0010)', () => {
  it('is never resolved by a memory server', () => {
    const run = spawnSync(
      process.execPath,
      ['--conditions=@sync-system/source', '--import', 'tsx', '--input-type=module', '-e', SCRIPT],
      {
        cwd: serverDir,
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout.trim().split('\n').pop()!) as Record<string, unknown>;
    expect(result).toEqual({ memory: { kind: 'memory' }, afterMemory: false, afterRedis: true });
  }, 60_000);
});
