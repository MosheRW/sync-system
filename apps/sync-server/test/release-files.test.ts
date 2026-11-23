// Release files (#37): license, package metadata, the publishable set and the
// release procedure's load-bearing lines. Reads the repo, starts nothing.
import { readFileSync } from 'node:fs';
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
