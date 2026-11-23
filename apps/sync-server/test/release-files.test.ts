// Release files (#37): license, package metadata, the publishable set and the
// release procedure's load-bearing lines. Reads the repo, starts nothing.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function readBytes(path: string): Buffer {
  return readFileSync(join(repoRoot, path));
}

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  [key: string]: unknown;
}

function manifest(dir: string): Manifest {
  return JSON.parse(read(join(dir, 'package.json'))) as Manifest;
}

const PUBLISHED_DIRS = ['packages/protocol', 'packages/client', 'packages/react'] as const;
const PUBLISHED_NAMES = [
  '@mosherw/sync-system-protocol',
  '@mosherw/sync-system-client',
  '@mosherw/sync-system-react',
] as const;
const ALL_DIRS = ['.', ...PUBLISHED_DIRS, 'apps/sync-server', 'apps/reader'] as const;

describe('license (AC53)', () => {
  it('has the GPL-3.0 text in the root LICENSE', () => {
    const text = read('LICENSE');
    expect(text).toContain('GNU GENERAL PUBLIC LICENSE');
    expect(text).toContain('Version 3, 29 June 2007');
    expect(text).toContain('END OF TERMS AND CONDITIONS');
  });

  it.each(PUBLISHED_DIRS)('ships a byte-equal LICENSE copy in %s', (dir) => {
    expect(readBytes(join(dir, 'LICENSE')).equals(readBytes('LICENSE'))).toBe(true);
  });

  it.each(ALL_DIRS)('declares GPL-3.0-only in %s/package.json', (dir) => {
    expect(manifest(dir).license).toBe('GPL-3.0-only');
  });
});

/** Every workspace package directory (`apps/*`, `packages/*` in pnpm-workspace.yaml). */
function workspaceDirs(): string[] {
  const workspace = read('pnpm-workspace.yaml');
  expect(workspace).toMatch(/- apps\/\*/);
  expect(workspace).toMatch(/- packages\/\*/);
  return ['apps', 'packages'].flatMap((parent) =>
    readdirSync(join(repoRoot, parent))
      .map((name) => `${parent}/${name}`)
      .filter((dir) => existsSync(join(repoRoot, dir, 'package.json'))),
  );
}

/** Tracked files, from git (the checks scan what would be published or made public). */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path.length > 0);
}

describe('published package metadata (AC50, Q-E)', () => {
  it.each(PUBLISHED_DIRS)('%s has repository, homepage and bugs URLs', (dir) => {
    const pkg = manifest(dir);
    expect(pkg.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/MosheRW/sync-system.git',
      directory: dir,
    });
    expect(pkg.homepage).toBe(`https://github.com/MosheRW/sync-system/tree/main/${dir}#readme`);
    expect(pkg.bugs).toEqual({ url: 'https://github.com/MosheRW/sync-system/issues' });
  });

  it.each(PUBLISHED_DIRS)('%s publishes publicly without the source condition', (dir) => {
    const pkg = manifest(dir);
    expect(pkg.publishConfig).toEqual({
      access: 'public',
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    });
    expect(pkg.files).toEqual(['dist', 'CHANGELOG.md']);
  });

  it.each(PUBLISHED_DIRS)('%s has its own README', (dir) => {
    expect(read(join(dir, 'README.md'))).toMatch(new RegExp(`^# ${manifest(dir).name}$`, 'm'));
  });
});

describe('publishable set (C4, security M3)', () => {
  it('has exactly the three published packages without private: true', () => {
    const publishable = workspaceDirs()
      .map((dir) => manifest(dir))
      .filter((pkg) => pkg.private !== true)
      .map((pkg) => pkg.name)
      .sort();
    expect(publishable).toEqual([...PUBLISHED_NAMES].sort());
  });

  it.each(['.', 'apps/sync-server', 'apps/reader'])('keeps %s private: true', (dir) => {
    expect(manifest(dir).private).toBe(true);
  });

  it('names the private packages in the @mosherw scope (Q-C)', () => {
    expect(manifest('apps/sync-server').name).toBe('@mosherw/sync-system-server');
    expect(manifest('apps/reader').name).toBe('@mosherw/sync-system-reader');
  });
});

describe('no credentials or old names in tracked files', () => {
  it('has no tracked .npmrc with an auth token (L6)', () => {
    const npmrcs = trackedFiles().filter((path) => /(^|\/)\.npmrc$/.test(path));
    for (const path of npmrcs) {
      expect(read(path), path).not.toMatch(/_authToken/);
    }
  });

  it('has no old placeholder scope left outside history (AC50, Q-C)', () => {
    const oldScope = ['@sync', '-system/'].join('');
    const history = /^(docs\/issues\/|docs\/decisions\/00(0\d|1[0-5])-)/;
    const hits = trackedFiles()
      .filter((path) => !history.test(path) && !path.endsWith('.zip'))
      .filter((path) => existsSync(join(repoRoot, path)) && read(path).includes(oldScope));
    expect(hits).toEqual([]);
  });
});
