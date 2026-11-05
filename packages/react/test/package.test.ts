import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as core from '@sync-system/client';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import type * as api from '../src/index.js';
import * as runtime from '../src/index.js';

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

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

const srcDir = join(root, 'src');
const sources = sourceFiles(srcDir).map((path) => ({
  path,
  name: relative(srcDir, path).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}));

/** Source without comments, so prose never trips a scan. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The files (relative to src) whose code matches `pattern`. */
function filesMatching(pattern: RegExp): string[] {
  return sources.filter((file) => pattern.test(code(file.text))).map((file) => file.name);
}

describe('imports (AC2)', () => {
  it('has no node, ws, next, react-dom or server imports in src', () => {
    const forbidden =
      /from\s+['"](node:[^'"]*|ws|next(\/[^'"]*)?|react-dom(\/[^'"]*)?|@sync-system\/server[^'"]*)['"]|import\(\s*['"](node:|ws['"]|next|react-dom)/;
    for (const file of sources) expect(file.text, file.name).not.toMatch(forbidden);
  });

  it('imports only react and @sync-system/client from outside the package', () => {
    const external = new Set<string>();
    for (const file of sources) {
      for (const match of file.text.matchAll(/from\s+['"]([^'".][^'"]*)['"]/g)) {
        external.add(match[1]!);
      }
    }
    expect([...external].sort()).toEqual(['@sync-system/client', 'react']);
  });

  it('re-exports the core types the hooks return (AC2)', () => {
    expectTypeOf<api.SyncClientSnapshot>().toEqualTypeOf<core.SyncClientSnapshot>();
    expectTypeOf<api.ConnectionState>().toEqualTypeOf<core.ConnectionState>();
    expectTypeOf<api.GroupState>().toEqualTypeOf<core.GroupState>();
    expectTypeOf<api.JoinCodes>().toEqualTypeOf<core.JoinCodes>();
    expectTypeOf<api.QrTicket>().toEqualTypeOf<core.QrTicket>();
    expectTypeOf<api.JoinRequest>().toEqualTypeOf<core.JoinRequest>();
    expectTypeOf<api.RosterEntry>().toEqualTypeOf<core.RosterEntry>();
    expectTypeOf<api.LeaderState>().toEqualTypeOf<core.LeaderState>();
    expectTypeOf<api.StoredGroupStatus>().toEqualTypeOf<core.StoredGroupStatus>();
    expectTypeOf<api.CreatedGroup>().toEqualTypeOf<core.CreatedGroup>();
    expectTypeOf<api.JoinedGroup>().toEqualTypeOf<core.JoinedGroup>();
    expectTypeOf<api.ResumedGroup>().toEqualTypeOf<core.ResumedGroup>();
    expectTypeOf<api.KeepAliveEvent>().toEqualTypeOf<core.KeepAliveEvent>();
    expectTypeOf<api.PreviewState>().toEqualTypeOf<core.PreviewState>();
    expectTypeOf<api.SyncClientEvents>().toEqualTypeOf<core.SyncClientEvents>();
    expectTypeOf<api.SyncClientOptions>().toEqualTypeOf<core.SyncClientOptions>();
    expectTypeOf<api.SyncIndicator>().toEqualTypeOf<core.SyncIndicator>();
    expectTypeOf<api.JsonValue>().toEqualTypeOf<core.JsonValue>();
    expectTypeOf<api.Role>().toEqualTypeOf<core.Role>();
    expectTypeOf<api.JoinMethod>().toEqualTypeOf<core.JoinMethod>();
    expect(runtime.SyncClientError).toBe(core.SyncClientError);
    expect(runtime.indicatorOf).toBe(core.indicatorOf);
  });
});

describe('no logging, no HTML, no URLs (AC27, R10, L3)', () => {
  it('has no console, logger, HTML injection or eval in src', () => {
    expect(filesMatching(/\bconsole\b/)).toEqual([]);
    expect(filesMatching(/\blogger\b|\.log\(/)).toEqual([]);
    expect(
      filesMatching(/dangerouslySetInnerHTML|innerHTML|outerHTML|\beval\(|new Function\(/),
    ).toEqual([]);
  });

  it('builds no URL and opens no connection of its own', () => {
    expect(
      filesMatching(
        /new URL\(|URLSearchParams|\blocation\b|\bhistory\b|\bfetch\(|XMLHttpRequest|new WebSocket\(/,
      ),
    ).toEqual([]);
  });

  it('reads globalThis only in host.ts', () => {
    expect(filesMatching(/\bglobalThis\b/)).toEqual(['host.ts']);
  });

  it('throws only fixed messages that name the package', () => {
    for (const file of sources) {
      for (const match of code(file.text).matchAll(/throw new (\w+)\(([^;]*)\);/g)) {
        const [, , message] = match;
        expect(
          /^'[^'$`]*'$/.test(message!) ||
            /^[A-Z_]+$/.test(message!) ||
            message === '`${hookName} must be used inside <SyncProvider> (@sync-system/react)`',
          `${file.name}: ${match[0]}`,
        ).toBe(true);
      }
    }
  });
});

describe('lint restrictions (AC27, R10, L3)', () => {
  interface Linter {
    calculateConfigForFile(path: string): Promise<{ rules?: Record<string, unknown> }>;
  }

  // Every source extension the package compiles, .tsx included.
  it.each(['ts', 'tsx'])('apply to every .%s file in src', async (extension) => {
    const requireRoot = createRequire(join(workspaceRoot, 'package.json'));
    const { ESLint } = (await import(pathToFileURL(requireRoot.resolve('eslint')).href)) as {
      ESLint: new (options: { cwd: string }) => Linter;
    };
    const eslint = new ESLint({ cwd: workspaceRoot });
    const config = await eslint.calculateConfigForFile(
      join(workspaceRoot, 'packages', 'react', 'src', 'hooks', `probe.${extension}`),
    );
    for (const rule of ['no-console', 'no-restricted-imports', 'no-restricted-globals']) {
      expect(config.rules?.[rule], `${rule} on .${extension}`).toEqual(expect.arrayContaining([2]));
    }
  });
});

describe('no automatic reconnect or rejoin (AC7, AC22, R5, section 9)', () => {
  it('calls connect() only in the provider (idle-guarded) and in useConnection', () => {
    expect(filesMatching(/\.connect\(/).sort()).toEqual(['hooks/connection.ts', 'provider.ts']);
    const provider = code(sources.find((file) => file.name === 'provider.ts')!.text);
    expect(provider.match(/\.connect\(/g)).toHaveLength(1);
    expect(provider).toMatch(/getState\(\)\.status === 'idle'\)\s*\{\s*[^}]*\.connect\(/);
  });

  it('calls close() only in the provider and in useConnection', () => {
    expect(filesMatching(/\.close\(/).sort()).toEqual(['hooks/connection.ts', 'provider.ts']);
  });

  it('joins and resumes only inside action callbacks; checks tokens only in the store', () => {
    expect(filesMatching(/\.joinByCode\(|\.joinByQr\(/)).toEqual(['hooks/join.ts']);
    expect(filesMatching(/\.resumeGroup\(/)).toEqual(['hooks/stored-groups.ts']);
    expect(filesMatching(/\.checkTokens\(/)).toEqual(['store.ts']);
    for (const name of ['hooks/join.ts', 'hooks/stored-groups.ts']) {
      const text = code(sources.find((file) => file.name === name)!.text);
      for (const match of text.matchAll(/\.(joinByCode|joinByQr|resumeGroup)\(/g)) {
        const before = text.slice(0, match.index);
        // Every call sits inside a useStoreAction callback.
        expect(before.lastIndexOf('useStoreAction('), `${name} ${match[1]}`).toBeGreaterThan(
          before.lastIndexOf('useEffect('),
        );
      }
    }
  });
});

describe('built output (AC3)', () => {
  const PURE = new Set([
    'host.js',
    'qr-controller.js',
    'server-state.js',
    'store.js',
    'to-sync-error.js',
    'types.js',
    'update-required.js',
  ]);

  // Its own output directory: the import test builds dist/ in parallel.
  const dist = mkdtempSync(join(tmpdir(), 'sync-react-dist-'));

  beforeAll(() => {
    execFileSync(
      process.execPath,
      [
        createRequire(import.meta.url).resolve('typescript/bin/tsc'),
        '-p',
        'tsconfig.build.json',
        '--outDir',
        dist,
      ],
      { cwd: root, stdio: 'pipe' },
    );
  }, 120_000);

  afterAll(() => {
    rmSync(dist, { recursive: true, force: true });
  });

  it('starts every client module with "use client" and ships types', () => {
    expect(existsSync(join(dist, 'index.d.ts'))).toBe(true);
    const modules = sourceFiles(dist)
      .filter((path) => path.endsWith('.js'))
      .map((path) => ({
        name: relative(dist, path).replaceAll('\\', '/'),
        text: readFileSync(path, 'utf8'),
      }));
    expect(modules.length).toBe(sources.length);
    for (const module of modules) {
      const first = module.text.split('\n')[0];
      if (PURE.has(module.name)) expect(first, module.name).not.toBe("'use client';");
      else expect(first, module.name).toBe("'use client';");
    }
  });
});
