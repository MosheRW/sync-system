import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as api from '../src/index.js';

const root = join(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe('package (AC1)', () => {
  it('depends at runtime only on @sync-system/protocol', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@sync-system/protocol']);
  });

  it('has no node, ws or UI framework imports in src', () => {
    const forbidden =
      /from\s+['"](node:[^'"]*|ws|react|react-dom|vue)['"]|import\(\s*['"](node:|ws['"])/;
    for (const file of sourceFiles(join(root, 'src'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(forbidden);
    }
  });
});

describe('public API (AC3)', () => {
  it('exports the runtime API from the entry point', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        'CLIENT_PROTOCOL_VERSION',
        'ClientErrorCode',
        'MIN_SERVER_PROTOCOL_VERSION',
        'SyncClient',
        'SyncClientError',
        'createSyncClient',
        'isSyncClientError',
      ].sort(),
    );
    expect(api.createSyncClient).toBeTypeOf('function');
  });

  it('points package exports at the built ESM output and types', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      type: string;
      exports: Record<string, Record<string, string>>;
    };
    expect(pkg.type).toBe('module');
    expect(pkg.exports['.']).toEqual({
      '@sync-system/source': './src/index.ts',
      types: './dist/index.d.ts',
      default: './dist/index.js',
    });
  });
});
