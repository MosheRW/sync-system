import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { run } from '../src/main.js';
import type { SyncServer } from '../src/server.js';
import { LogCapture } from './helpers/log-capture.js';
import { waitUntil } from './helpers/wait.js';
import { TEST_REDIS_URL, describeRedis, inspector, randomPrefix } from './helpers/redis.js';
import { CHILD_START_MS, childEnv } from './helpers/child-env.js';

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

  /**
   * A Redis user that passes the connect checks (INFO) but may not GET, so
   * the epoch read inside `storage.start` fails (QA round 1 finding 2).
   */
  async function userWithoutGet(prefix: string) {
    const inspect = await inspector();
    const name = `sync-test-${randomBytes(4).toString('hex')}`;
    const password = `SENTINEL-acl-${randomBytes(8).toString('hex')}`;
    await inspect.client.sendCommand([
      'ACL',
      'SETUSER',
      name,
      'reset',
      'on',
      `>${password}`,
      `~${prefix}:*`,
      'resetchannels',
      '+@all',
      '-get',
    ]);
    const url = new URL(TEST_REDIS_URL!);
    url.username = name;
    url.password = password;
    return {
      url: url.toString(),
      name,
      password,
      /** Connections of this user still open. */
      async connections(): Promise<number> {
        const list = await inspect.client.sendCommand<string>(['CLIENT', 'LIST']);
        return list.split('\n').filter((line) => line.includes(` user=${name} `)).length;
      },
      async remove(): Promise<void> {
        await inspect.client.sendCommand(['ACL', 'DELUSER', name]);
        await inspect.flush(prefix);
        inspect.close();
      },
    };
  }

  it('a Redis failure while starting is a Redis Startup error: link closed, nothing listening (AC4)', async () => {
    const prefix = randomPrefix();
    const user = await userWithoutGet(prefix);
    try {
      const port = await freePort();
      let stderr = '';
      const logs = new LogCapture();
      const result = await run(
        {
          PORT: String(port),
          HOST: '127.0.0.1',
          TOKEN_SECRET,
          SYNC_CONFIG_PATH: config(),
          REDIS_URL: user.url,
          REDIS_KEY_PREFIX: prefix,
          NODE_ENV: 'test',
        },
        { stderr: (text) => (stderr += text), destination: logs },
      );
      expect(result).toEqual({ ok: false, exitCode: 1 });
      expect(stderr).toBe('Startup error: Redis authentication failed (REDIS_URL)\n');
      for (const secret of [user.password, user.name, prefix]) {
        expect(stderr).not.toContain(secret);
        expect(logs.text).not.toContain(secret);
      }
      // The server closes the link; Redis drops the client soon after.
      await waitUntil(async () => (await user.connections()) === 0, 5000, 'link closed');
      // Nothing listens on the port.
      await new Promise<void>((resolve, reject) => {
        const probe = createServer();
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
      });
    } finally {
      await user.remove();
    }
  });

  it('the process exits 1 after a Redis failure while starting (AC4)', async () => {
    const prefix = randomPrefix();
    const user = await userWithoutGet(prefix);
    try {
      const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: childEnv({
          PORT: String(await freePort()),
          HOST: '127.0.0.1',
          TOKEN_SECRET,
          SYNC_CONFIG_PATH: config(),
          REDIS_URL: user.url,
          REDIS_KEY_PREFIX: prefix,
          NODE_ENV: 'test',
          NODE_OPTIONS: '--conditions=@mosherw/sync-system-source',
        }),
        encoding: 'utf8',
        // #87: see CHILD_START_MS.
        timeout: CHILD_START_MS,
      });
      expect(child.signal).toBeNull();
      expect(child.status).toBe(1);
      expect(child.stderr).toContain('Startup error: Redis authentication failed (REDIS_URL)');
      expect(child.stderr).not.toContain(user.password);
      expect(child.stdout).not.toContain(user.password);
    } finally {
      await user.remove();
    }
  // #87: see CHILD_START_MS.
  }, CHILD_START_MS + 30_000);
});
