import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { codesOf } from './helpers/groups.js';
import { TEST_REDIS_URL, describeRedis, inspector, randomPrefix } from './helpers/redis.js';
import { TestClient } from './helpers/test-client.js';
import { CHILD_START_MS, childEnv } from './helpers/child-env.js';

/** Test-only values, never real ones. */
const API_KEY = 'multi-process-key-0123456789-0123456789-ab';
const TOKEN_SECRET = 'mP3kQ2zLp5Vn9Xb3Mc7Hd1Jf6Gs4Wy0Ue2Ia8Oo5Kq=';
const serverDir = fileURLToPath(new URL('..', import.meta.url));

const children: ChildProcess[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Starts `src/index.ts` in a new process; resolves once it logs server_listening. */
function startProcess(env: Record<string, string>): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: serverDir,
      env: childEnv({ ...env, NODE_OPTIONS: '--conditions=@mosherw/sync-system-source' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    // #87: see CHILD_START_MS.
    const timer = setTimeout(() => reject(new Error('server did not start')), CHILD_START_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes('"event":"server_listening"')) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code ?? 'signal'}`));
    });
  });
}

async function connect(url: string): Promise<TestClient> {
  const client = await TestClient.connect(url);
  const reply = await client.hello({ apiKey: API_KEY });
  if (reply.type !== 'hello.ok') throw new Error(`hello failed: ${JSON.stringify(reply)}`);
  return client;
}

describeRedis('two server processes on one Redis (#35 AC21, AC29)', () => {
  let inspect: Awaited<ReturnType<typeof inspector>>;
  let prefix: string;
  let dir: string;

  beforeAll(async () => {
    inspect = await inspector();
  });
  afterAll(() => {
    inspect.close();
  });
  afterEach(async () => {
    for (const child of children.splice(0)) child.kill();
    await inspect.flush(prefix);
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "a killed process's clients reconnect through the other and the group goes on",
    { timeout: CHILD_START_MS + 60_000 },
    async () => {
      prefix = randomPrefix();
      dir = mkdtempSync(join(tmpdir(), 'sync-multi-'));
      const configPath = join(dir, 'apps.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          apps: [{ namespace: 'multi-app', apiKey: API_KEY, minAppVersion: '1.0.0' }],
        }),
      );
      const env = (port: number) => ({
        SYNC_CONFIG_PATH: configPath,
        PORT: String(port),
        HOST: '127.0.0.1',
        NODE_ENV: 'production',
        TOKEN_SECRET,
        LOG_LEVEL: 'info',
        REDIS_URL: TEST_REDIS_URL!,
        REDIS_KEY_PREFIX: prefix,
      });
      const [portA, portB] = [await freePort(), await freePort()];
      const [a, b] = await Promise.all([startProcess(env(portA)), startProcess(env(portB))]);
      const urlA = `ws://127.0.0.1:${portA}/ws`;
      const urlB = `ws://127.0.0.1:${portB}/ws`;
      const leader = await connect(urlA);
      leader.send({ type: 'group.create', metadata: { book: 'b' }, position: { page: 1 } });
      const created = await leader.next('group.created');
      const member = await connect(urlB);
      member.send({ type: 'group.joinByCode', ...codesOf(created.codes) });
      const joined = await member.next('group.joined');
      leader.send({ type: 'position.update', position: { page: 2 } });
      await leader.next('position.ack');
      expect(await member.next('position.updated')).toMatchObject({ position: { page: 2 } });

      b.kill('SIGKILL');
      await member.closed();
      // The member reconnects through A at once: the group lives in Redis.
      const again = await connect(urlA);
      again.send({ type: 'group.resume', token: joined.token });
      expect(await again.next('group.joined')).toMatchObject({
        groupId: created.groupId,
        participantId: joined.participantId,
        position: { page: 2 },
      });
      leader.send({ type: 'position.update', position: { page: 3 } });
      await leader.next('position.ack');
      expect(await again.next('position.updated')).toMatchObject({ position: { page: 3 } });
      leader.terminate();
      again.terminate();
      expect(a.exitCode).toBeNull();
    },
  );
});
