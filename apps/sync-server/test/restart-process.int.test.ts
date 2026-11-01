import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TestClient } from './helpers/test-client.js';

/** Test-only values, never real ones. */
const API_KEY = 'restart-test-key-0123456789-0123456789-abc';
const TOKEN_SECRET = 'rT8kQ2zLp5Vn9Xb3Mc7Hd1Jf6Gs4Wy0Ue2Ia8Oo5Kq=';
const serverDir = fileURLToPath(new URL('..', import.meta.url));

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

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
      env: { ...process.env, ...env, NODE_OPTIONS: '--conditions=@sync-system/source' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '';
    const timer = setTimeout(() => reject(new Error('server did not start')), 30_000);
    child.stdout!.on('data', (chunk: Buffer) => {
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

function stopProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.removeAllListeners('exit');
    child.once('exit', () => resolve());
    child.kill();
  });
}

async function connect(url: string): Promise<TestClient> {
  const client = await TestClient.connect(url);
  const reply = await client.hello({ apiKey: API_KEY });
  if (reply.type !== 'hello.ok') throw new Error(`hello failed: ${JSON.stringify(reply)}`);
  return client;
}

describe('recovery across a real process restart (#5 AC23)', () => {
  it('recreates the group in a new process with the same secret', { timeout: 90_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-restart-'));
    const configPath = join(dir, 'apps.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        apps: [{ namespace: 'restart-app', apiKey: API_KEY, minAppVersion: '1.0.0' }],
      }),
    );
    const port = await freePort();
    const env = {
      SYNC_CONFIG_PATH: configPath,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      TOKEN_SECRET,
      LOG_LEVEL: 'info',
    };
    const url = `ws://127.0.0.1:${port}/ws`;

    const first = await startProcess(env);
    const leader = await connect(url);
    leader.send({ type: 'group.create', metadata: { book: 'b' }, position: { page: 1 } });
    const created = await leader.next('group.created');
    const member = await connect(url);
    member.send({ type: 'group.join', groupId: created.groupId });
    const joined = await member.next('group.joined');
    leader.send({ type: 'position.update', position: { page: 2 } });
    await leader.next('position.ack');
    await member.next('position.updated');

    await stopProcess(first);
    leader.terminate();
    member.terminate();

    await startProcess(env);
    const newLeader = await connect(url);
    newLeader.send({
      type: 'group.resume',
      token: created.token,
      metadata: { book: 'b' },
      position: { page: 2 },
    });
    const resumed = await newLeader.next('group.resumed');
    expect(resumed).toMatchObject({
      groupId: created.groupId,
      participantId: created.participantId,
      recreated: true,
      position: { page: 2 },
    });

    const newMember = await connect(url);
    newMember.send({ type: 'group.resume', token: joined.token });
    expect(await newMember.next('group.joined')).toMatchObject({
      groupId: created.groupId,
      participantId: joined.participantId,
      position: { page: 2 },
    });
    newLeader.send({ type: 'position.update', position: { page: 3 } });
    await newLeader.next('position.ack');
    expect(await newMember.next('position.updated')).toMatchObject({ position: { page: 3 } });
    newLeader.terminate();
    newMember.terminate();
  });
});
