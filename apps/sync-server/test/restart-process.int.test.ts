import { codesOf } from './helpers/groups.js';
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TestClient } from './helpers/test-client.js';
import { claimsOf } from './helpers/tokens.js';
import { childEnv } from './helpers/child-env.js';

/** Test-only values, never real ones. */
const API_KEY = 'restart-test-key-0123456789-0123456789-abc';
const TOKEN_SECRET = 'rT8kQ2zLp5Vn9Xb3Mc7Hd1Jf6Gs4Wy0Ue2Ia8Oo5Kq=';
const serverDir = fileURLToPath(new URL('..', import.meta.url));

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

/** Resolves once the wall clock is past the end of epoch second `second`. */
async function untilAfterSecond(second: number): Promise<void> {
  const wait = (second + 1) * 1000 + 50 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

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
    const timer = setTimeout(() => reject(new Error('server did not start')), 30_000);
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

describe('recovery across a real process restart (#5 AC23, #10 AC35)', () => {
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
    member.send({ type: 'group.joinByCode', ...codesOf(created.codes) });
    const joined = await member.next('group.joined');
    leader.send({ type: 'position.update', position: { page: 2 } });
    await leader.next('position.ack');
    await member.next('position.updated');

    await stopProcess(first);
    leader.terminate();
    member.terminate();
    // A token issued in the second the new process starts counts as issued
    // by it, and its group is then ended, not recovered (#13 6.9 layer 2,
    // fail closed). A real restart takes longer; here, wait for the next
    // second so the test does not depend on how fast the process starts.
    await untilAfterSecond(Math.max(claimsOf(created.token).iat, claimsOf(joined.token).iat));

    await startProcess(env);
    const newLeader = await connect(url);
    newLeader.send({
      type: 'group.resume',
      token: created.token,
      metadata: { book: 'b' },
      position: { page: 2 },
      joinCodes: created.codes.blob,
    });
    const resumed = await newLeader.next('group.resumed');
    expect(resumed).toMatchObject({
      groupId: created.groupId,
      participantId: created.participantId,
      recreated: true,
      position: { page: 2 },
      // Same codes after the restart: the blob verifies with the same secret (#10 AC35).
      codesChanged: false,
      codes: {
        generation: created.codes.generation,
        groupCode: created.codes.groupCode,
        doorCode: created.codes.doorCode,
      },
    });
    const newcomer = await connect(url);
    newcomer.send({ type: 'group.joinByCode', ...codesOf(created.codes) });
    expect(await newcomer.next('group.joined')).toMatchObject({ groupId: created.groupId });
    newcomer.terminate();

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
