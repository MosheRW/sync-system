import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../src/main.js';
import type { SyncServer } from '../src/server.js';
import { LogCapture } from './helpers/log-capture.js';
import { httpGet } from './helpers/test-server.js';

const SECRET_KEY = 'SENTINEL-main-key-0123456789-0123456789-xyz';
const devConfigPath = fileURLToPath(new URL('../../../config/apps.dev.json', import.meta.url));
const serverDir = fileURLToPath(new URL('..', import.meta.url));

function writeConfig(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sync-main-'));
  const path = join(dir, 'apps.json');
  writeFileSync(path, text);
  return path;
}

const validConfig = JSON.stringify({
  apps: [{ namespace: 'main-app', apiKey: SECRET_KEY, minAppVersion: '1.0.0' }],
});

let started: SyncServer | undefined;

/** A port that was free a moment ago (PORT must be 1-65535, so 0 is not allowed). */
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

afterEach(async () => {
  await started?.close();
  started = undefined;
});

async function runCapture(env: Record<string, string>) {
  let stderr = '';
  const logs = new LogCapture();
  const result = await run(
    { PORT: String(await freePort()), HOST: '127.0.0.1', ...env },
    { stderr: (text) => (stderr += text), destination: logs },
  );
  if (result.ok) started = result.server;
  return { result, stderr, logs };
}

describe('run', () => {
  it('starts with the file at SYNC_CONFIG_PATH and serves /health (AC4)', async () => {
    const { result, logs } = await runCapture({
      SYNC_CONFIG_PATH: writeConfig(validConfig),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const res = await httpGet(result.server.port, '/health');
    expect(res.status).toBe(200);
    const listening = logs.records().find((r) => r.event === 'server_listening');
    expect(listening).toMatchObject({ port: result.server.port });
    expect(logs.text).not.toContain('127.0.0.1');
    expect(logs.text).not.toContain('SENTINEL');
  });

  it('returns exit code 1 with a readable message for a missing file (AC6)', async () => {
    const { result, stderr } = await runCapture({ SYNC_CONFIG_PATH: '/no/such/apps.json' });
    expect(result).toEqual({ ok: false, exitCode: 1 });
    expect(stderr).toMatch(/^Config error: .*apps\.json: config file not found/);
  });

  it('returns exit code 1 for an invalid env variable (AC6)', async () => {
    const { result, stderr } = await runCapture({ MAX_GROUP_SIZE_CEILING: 'abc' });
    expect(result).toEqual({ ok: false, exitCode: 1 });
    expect(stderr).toContain('Config error: MAX_GROUP_SIZE_CEILING must be a positive integer');
  });

  it('reports invalid JSON by position without printing the key (M2)', async () => {
    const path = writeConfig(`{"apps":[{"namespace":"a","apiKey":"${SECRET_KEY}" oops}]}`);
    const { result, stderr } = await runCapture({ SYNC_CONFIG_PATH: path });
    expect(result).toEqual({ ok: false, exitCode: 1 });
    expect(stderr).toMatch(/not valid JSON \(line 1, column \d+\)/);
    expect(stderr).not.toContain('SENTINEL');
  });

  it('refuses the dev key in production without printing it (M6)', async () => {
    const { result, stderr } = await runCapture({
      SYNC_CONFIG_PATH: devConfigPath,
      NODE_ENV: 'production',
    });
    expect(result).toEqual({ ok: false, exitCode: 1 });
    expect(stderr).toContain('(namespace "dev-app") uses the public development API key');
    expect(stderr).not.toContain('dev-only-insecure');
  });

  it('starts with the dev key in development and warns with the namespace (M6)', async () => {
    const { result, logs } = await runCapture({
      SYNC_CONFIG_PATH: devConfigPath,
      NODE_ENV: 'development',
    });
    expect(result.ok).toBe(true);
    const warning = logs.records().find((r) => r.event === 'dev_api_key');
    expect(warning).toMatchObject({ level: 40, namespace: 'dev-app', msg: 'dev api key in use' });
    expect(logs.text).not.toContain('dev-only-insecure');
  });

  it('returns exit code 1 when the port is taken', async () => {
    const first = await runCapture({ SYNC_CONFIG_PATH: writeConfig(validConfig) });
    if (!first.result.ok) throw new Error('first server did not start');
    const port = String(first.result.server.port);
    let stderr = '';
    const second = await run(
      { SYNC_CONFIG_PATH: writeConfig(validConfig), PORT: port, HOST: '127.0.0.1' },
      { stderr: (text) => (stderr += text), destination: new LogCapture() },
    );
    expect(second).toEqual({ ok: false, exitCode: 1 });
    expect(stderr).toContain('EADDRINUSE');
  });
});

describe('process entry (AC6)', () => {
  it('exits non-zero and prints the config error to stderr', () => {
    const path = writeConfig(
      JSON.stringify({
        apps: [
          { namespace: 'a', apiKey: SECRET_KEY, minAppVersion: '1.0.0' },
          { namespace: 'b', apiKey: SECRET_KEY, minAppVersion: '1.0.0' },
        ],
      }),
    );
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: serverDir,
      env: {
        ...process.env,
        SYNC_CONFIG_PATH: path,
        NODE_OPTIONS: '--conditions=@sync-system/source',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain(
      'Config error: ' +
        path +
        ': apps[1] (namespace "b") has the same apiKey as apps[0] (namespace "a")',
    );
    expect(child.stderr).not.toContain('SENTINEL');
    expect(child.stdout).not.toContain('SENTINEL');
  });
});
