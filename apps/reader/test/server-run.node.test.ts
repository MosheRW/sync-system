// @vitest-environment node
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { run } from '../server/run.js';
import { makeDist } from './helpers/server.js';

const dist = makeDist();
const empty = makeDist([]);

afterAll(() => {
  dist.cleanup();
  empty.cleanup();
});

async function startWith(env: Record<string, string>, distDir = dist.dir) {
  const stderr: string[] = [];
  const stdout: string[] = [];
  const result = await run(
    { PORT: '0', HOST: '127.0.0.1', ...env },
    { distDir, stderr: (t) => stderr.push(t), stdout: (t) => stdout.push(t) },
  );
  if (result.ok) await result.close();
  return { result, stderr: stderr.join(''), stdout: stdout.join('') };
}

describe('server startup (AC30, AC41, security C9)', () => {
  it('starts with the defaults and prints only the port', async () => {
    const { result, stdout, stderr } = await startWith({});
    expect(result.ok).toBe(true);
    expect(stdout).toMatch(/^reader listening on port \d+\n$/);
    expect(stdout).not.toContain('127.0.0.1');
    expect(stderr).toBe('');
  });

  it('exits 1 listing every config problem', async () => {
    const { result, stderr } = await startWith({
      READER_ENTRY: 'x',
      READER_SRC_ORIGINS: 'https://a.example/',
      TOKEN_SECRET: 'never-print-me',
    });
    expect(result).toEqual({ ok: false, exitCode: 1 });
    const lines = stderr.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(/^Config error: /);
    expect(stderr).not.toContain('never-print-me');
  });

  it('exits 1 for an unknown default book', async () => {
    const { result, stderr } = await startWith({
      READER_ENTRY: 'default-book',
      READER_BOOK: 'acme/missing',
    });
    expect(result).toEqual({ ok: false, exitCode: 1 });
    expect(stderr).toBe('Config error: READER_BOOK "acme/missing" is not a bundled book\n');
  });

  it('exits 1 with the library on and zero books (AC41)', async () => {
    const { result, stderr } = await startWith({}, empty.dir);
    expect(result).toEqual({ ok: false, exitCode: 1 });
    expect(stderr).toContain('no books are bundled');
  });

  it('starts with zero books when the library is off', async () => {
    const { result } = await startWith({ READER_ENTRY: 'error', READER_LIBRARY: 'off' }, empty.dir);
    expect(result.ok).toBe(true);
  });

  it('warns about loopback origins in production (F9)', async () => {
    const { result, stderr } = await startWith({
      NODE_ENV: 'production',
      READER_SRC_ORIGINS: 'http://localhost:3000',
    });
    expect(result.ok).toBe(true);
    expect(stderr).toMatch(/^Warning: READER_SRC_ORIGINS contains http:\/\/localhost:3000/);
  });

  it('exits 1 without a built library index or index template', async () => {
    const broken = makeDist();
    rmSync(join(broken.dir, 'library-index.json'));
    expect((await startWith({}, broken.dir)).result).toEqual({ ok: false, exitCode: 1 });
    writeFileSync(join(broken.dir, 'library-index.json'), '[]');
    writeFileSync(join(broken.dir, 'index.html'), '<html></html>');
    const noPlaceholder = await startWith(
      { READER_ENTRY: 'error', READER_LIBRARY: 'off' },
      broken.dir,
    );
    expect(noPlaceholder.result).toEqual({ ok: false, exitCode: 1 });
    expect(noPlaceholder.stderr).toContain('no config placeholder');
    broken.cleanup();
  });
});
