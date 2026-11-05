import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const workspaceRoot = join(root, '..', '..');

interface PackageJson {
  name: string;
  private?: boolean;
  type?: string;
  sideEffects?: boolean;
  exports: Record<string, Record<string, string>>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;

describe('package (AC1, Q1, Q2, Q10)', () => {
  it('is the private workspace package @sync-system/react', () => {
    expect(pkg.name).toBe('@sync-system/react');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
    expect(pkg.sideEffects).toBe(false);
  });

  it('depends at runtime only on @sync-system/client (R13)', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['@sync-system/client']);
    expect(pkg.dependencies?.['@sync-system/client']).toBe('workspace:*');
  });

  it('lists react as a peer dependency, ^18.3 || ^19', () => {
    expect(pkg.peerDependencies).toEqual({ react: '^18.3 || ^19' });
  });

  it('has no next dependency of any kind (Q3)', () => {
    const all = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies };
    expect(Object.keys(all).filter((name) => name === 'next' || name.startsWith('@next/'))).toEqual(
      [],
    );
  });

  it('points package exports at the built ESM output and types (AC3)', () => {
    expect(pkg.exports['.']).toEqual({
      '@sync-system/source': './src/index.ts',
      types: './dist/index.d.ts',
      default: './dist/index.js',
    });
  });

  it('has the scripts the root checks run (pnpm -r)', () => {
    expect(Object.keys(pkg.scripts ?? {}).sort()).toEqual(['build', 'test', 'typecheck']);
    const workspace = readFileSync(join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8');
    expect(workspace).toContain('packages/*');
  });
});
