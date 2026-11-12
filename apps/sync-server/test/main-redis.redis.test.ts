import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { run } from '../src/main.js';
import type { SyncServer } from '../src/server.js';
import { LogCapture } from './helpers/log-capture.js';
import { TEST_REDIS_URL, describeRedis, inspector, randomPrefix } from './helpers/redis.js';

const TOKEN_SECRET = 'SENTINEL-tok-8f3Kq2Lp9Zx7Vb4Nm1Rt6Yw0Ue5Io3Aa';
let started: SyncServer | undefined;

afterEach(async () => {
  await started?.close();
  started = undefined;
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function config(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sync-main-redis-'));
  const path = join(dir, 'apps.json');
  writeFileSync(
    path,
    JSON.stringify({
      apps: [
        {
          namespace: 'main-app',
          apiKey: 'SENTINEL-key-0123456789-0123456789-ab',
          minAppVersion: '1.0.0',
        },
      ],
    }),
  );
  return path;
}

describeRedis('run() with REDIS_URL (#35 AC2, AC4, AC27)', () => {
  it('starts on Redis and reports the Redis storage as connected', async () => {
    const prefix = randomPrefix();
    const logs = new LogCapture();
    const result = await run(
      {
        PORT: String(await freePort()),
        HOST: '127.0.0.1',
        TOKEN_SECRET,
        SYNC_CONFIG_PATH: config(),
        REDIS_URL: TEST_REDIS_URL!,
        REDIS_KEY_PREFIX: prefix,
        NODE_ENV: 'test',
      },
      { stderr: () => undefined, destination: logs },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    started = result.server;
    expect(result.server.storage()).toEqual({ kind: 'redis', state: 'connected' });
    expect(logs.find('redis_connected')).toBeDefined();
    const password = new URL(TEST_REDIS_URL!).password;
    if (password !== '') expect(logs.text).not.toContain(password);
    const inspect = await inspector();
    await inspect.flush(prefix);
    inspect.close();
  });

  it('prints an authentication Startup error for a wrong password (AC4)', async () => {
    const url = new URL(TEST_REDIS_URL!);
    url.password = 'SENTINEL-wrong';
    let stderr = '';
    const result = await run(
      {
        PORT: String(await freePort()),
        HOST: '127.0.0.1',
        TOKEN_SECRET,
        SYNC_CONFIG_PATH: config(),
        REDIS_URL: url.toString(),
      },
      { stderr: (text) => (stderr += text), destination: new LogCapture() },
    );
    expect(result).toEqual({ ok: false, exitCode: 1 });
    expect(stderr).toBe('Startup error: Redis authentication failed (REDIS_URL)\n');
  });
});
