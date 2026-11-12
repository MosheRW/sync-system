import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';

const readerRoot = join(import.meta.dirname, '..', '..');
const repoRoot = join(readerRoot, '..', '..');

/** The committed public dev key of `dev-app` (config/apps.dev.json); never a real key (R11). */
export const DEV_API_KEY = 'dev-only-insecure-api-key-change-me-please';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Starts a built Node entry point and waits for its startup line. */
function startProcess(
  entry: string,
  env: Record<string, string>,
  ready: RegExp,
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: repoRoot,
      env: { PATH: process.env['PATH'] ?? '', SYSTEMROOT: process.env['SYSTEMROOT'] ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => reject(new Error(`${entry} did not start:\n${output}`)), 20_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (ready.test(output)) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${entry} exited with ${String(code)}:\n${output}`));
    });
  });
}

/** The dev apps config (the committed public dev key). */
export const DEV_CONFIG = join(repoRoot, 'config', 'apps.dev.json');

/**
 * The lifecycle stack's config (#25 13.2, R23): the same `dev-app` and dev
 * key with a 5 s grace and `auto` handoff, nothing else relaxed.
 */
export const LIFECYCLE_CONFIG = join(readerRoot, 'e2e', 'fixtures', 'apps.lifecycle.json');

/** The real sync server (built), loopback only, dev key, a random token secret per run (R11). */
export async function startSyncServer(
  port: number,
  configPath: string = DEV_CONFIG,
): Promise<ChildProcess> {
  return startProcess(
    join(repoRoot, 'apps', 'sync-server', 'dist', 'index.js'),
    {
      NODE_ENV: 'development',
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'info',
      SYNC_CONFIG_PATH: configPath,
      TOKEN_SECRET: randomBytes(32).toString('base64'),
    },
    /server_listening|listening/,
  );
}

/** The built reader server with the production CSP and headers, pointed at `syncPort`. */
export async function startReader(port: number, syncPort: number): Promise<ChildProcess> {
  return startProcess(
    join(readerRoot, 'dist-server', 'server', 'main.js'),
    {
      NODE_ENV: 'development',
      PORT: String(port),
      HOST: '127.0.0.1',
      READER_SYNC_URL: `ws://127.0.0.1:${syncPort}/ws`,
      READER_SYNC_API_KEY: DEV_API_KEY,
    },
    /reader listening on port/,
  );
}
