// pnpm smoke (#37 AC51, C6). Installs the packed tarballs into a clean project
// outside the workspace and checks them the way an app would use them:
//   1. ESM import of each package under Node (the documented exports exist);
//   2. tsc --noEmit on a file importing every public name, with
//      moduleResolution NodeNext and with Bundler;
//   3. renderToString(<SyncProvider options>) under Node with no browser
//      globals: no throw and no socket (SSR safety, #15).
// The install runs with --ignore-scripts and --offline, and pins react,
// react-dom and their types to the exact versions the workspace lockfile
// resolved (never ranges). The temp project is removed in `finally`.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PUBLISHED, packAll, pnpmCommand, readTarball, repoRoot, run } from './lib.ts';

/** The packages pinned to the workspace's resolved versions. */
export const PINNED = ['react', 'react-dom', '@types/react', '@types/react-dom'] as const;

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

interface ListedDependency {
  version?: unknown;
}

interface ListedPackage {
  name?: unknown;
  dependencies?: Record<string, ListedDependency>;
  devDependencies?: Record<string, ListedDependency>;
}

/**
 * Exact versions of PINNED from `pnpm list --json --depth 0` output for the
 * React package. Throws if a package is missing or not an exact version.
 */
export function exactVersions(listJson: string): Record<string, string> {
  const listed = JSON.parse(listJson) as ListedPackage[];
  const react = listed.find((p) => p.name === '@mosherw/sync-system-react');
  if (react === undefined) throw new Error('pnpm list has no @mosherw/sync-system-react');
  const all = { ...react.devDependencies, ...react.dependencies };
  const versions: Record<string, string> = {};
  for (const name of PINNED) {
    const version = all[name]?.version;
    if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
      throw new Error(`${name}: no exact version in the lockfile (got ${String(version)})`);
    }
    versions[name] = version;
  }
  return versions;
}

/** Every name a package's dist/index.d.ts exports (`export { a, type B } from`). */
export function exportedNames(dts: string): string[] {
  const names = new Set<string>();
  for (const match of dts.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of (match[1] ?? '').split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name !== undefined && name !== '') names.add(name);
    }
  }
  return [...names].sort();
}

function write(dir: string, file: string, content: string): void {
  writeFileSync(join(dir, file), content);
}

function typeCheckFiles(dir: string, packed: Record<string, string>): void {
  const imports = PUBLISHED.map((pkg, index) => {
    const tgz = readTarball(readFileSync(join(dir, packed[pkg.name] ?? '')));
    const dts = tgz.find((e) => e.path === 'package/dist/index.d.ts');
    const names = exportedNames(dts?.content.toString('utf8') ?? '');
    if (names.length === 0) throw new Error(`${pkg.name}: no exports found in dist/index.d.ts`);
    const aliased = names.map((name) => `${name} as p${index}_${name}`);
    return `import type { ${aliased.join(', ')} } from '${pkg.name}';`;
  });
  write(dir, 'types.ts', `${imports.join('\n')}\nexport {};\n`);
  write(
    dir,
    'app.tsx',
    [
      "import { SyncProvider, useConnection } from '@mosherw/sync-system-react';",
      "import { SyncClient, type SyncClientOptions } from '@mosherw/sync-system-client';",
      "import { PROTOCOL_VERSION } from '@mosherw/sync-system-protocol';",
      '',
      "const options: SyncClientOptions = { url: 'ws://127.0.0.1:9/ws', apiKey: 'k', appVersion: '1.0.0' };",
      'const version: number = PROTOCOL_VERSION;',
      'export const client: SyncClient = new SyncClient(options);',
      'function Status() {',
      '  const { state } = useConnection();',
      '  return <p>{String(state)} {version}</p>;',
      '}',
      'export const app = (',
      '  <SyncProvider options={options} autoConnect={false}>',
      '    <Status />',
      '  </SyncProvider>',
      ');',
      '',
    ].join('\n'),
  );
}

function tsconfig(moduleResolution: 'NodeNext' | 'Bundler'): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      lib: ['ES2023', 'DOM'],
      module: moduleResolution === 'NodeNext' ? 'NodeNext' : 'ESNext',
      moduleResolution,
      jsx: 'react-jsx',
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: [],
    },
    files: ['types.ts', 'app.tsx'],
  });
}

const IMPORT_CHECK = `
import * as protocol from '@mosherw/sync-system-protocol';
import * as client from '@mosherw/sync-system-client';
import * as react from '@mosherw/sync-system-react';
const fail = (message) => { console.error('smoke: ' + message); process.exit(1); };
if (protocol.PROTOCOL_VERSION !== 1) fail('PROTOCOL_VERSION is not 1');
if (protocol.MIN_CLIENT_PROTOCOL_VERSION !== 1) fail('MIN_CLIENT_PROTOCOL_VERSION is not 1');
if (typeof protocol.parseServerMessage !== 'function') fail('protocol.parseServerMessage missing');
if (typeof client.SyncClient !== 'function') fail('client.SyncClient missing');
if (typeof client.createSyncClient !== 'function') fail('client.createSyncClient missing');
if (typeof react.SyncProvider !== 'function') fail('react.SyncProvider missing');
if (typeof react.useConnection !== 'function') fail('react.useConnection missing');
console.log('smoke: imports ok');
`;

const SSR_CHECK = `
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { SyncProvider } from '@mosherw/sync-system-react';
const fail = (message) => { console.error('smoke: ' + message); process.exit(1); };
// Node itself defines navigator (and WebSocket, replaced below); these must not exist.
for (const name of ['window', 'document', 'localStorage', 'sessionStorage']) {
  if (name in globalThis) fail('browser global ' + name + ' exists under Node');
}
let sockets = 0;
globalThis.WebSocket = class { constructor() { sockets += 1; } };
const options = { url: 'ws://127.0.0.1:9/ws', apiKey: 'smoke', appVersion: '1.0.0' };
const html = renderToString(createElement(SyncProvider, { options }, createElement('p', null, 'ssr-ok')));
if (!html.includes('ssr-ok')) fail('provider did not render its children');
if (sockets !== 0) fail('a socket was opened during server rendering');
console.log('smoke: ssr ok');
`;

function main(): void {
  const pnpm = pnpmCommand();
  const versions = exactVersions(
    run(
      pnpm,
      ['list', '--filter', '@mosherw/sync-system-react', '--json', '--depth', '0'],
      repoRoot,
    ),
  );
  const dir = mkdtempSync(join(tmpdir(), 'sync-smoke-'));
  try {
    const files = packAll(dir);
    const packed: Record<string, string> = {};
    const overrides: Record<string, string> = {};
    PUBLISHED.forEach((pkg, index) => {
      const file = files[index] ?? '';
      packed[pkg.name] = file;
      overrides[pkg.name] = `file:./${file}`;
    });
    write(
      dir,
      'package.json',
      `${JSON.stringify(
        {
          name: 'sync-system-smoke',
          private: true,
          type: 'module',
          dependencies: {
            ...overrides,
            react: versions['react'],
            'react-dom': versions['react-dom'],
          },
          devDependencies: {
            '@types/react': versions['@types/react'],
            '@types/react-dom': versions['@types/react-dom'],
          },
          pnpm: { overrides },
        },
        null,
        2,
      )}\n`,
    );
    console.log(`smoke: installing into ${dir}`);
    run(pnpm, ['install', '--ignore-scripts', '--offline', '--reporter', 'append-only'], dir);

    write(dir, 'imports.mjs', IMPORT_CHECK);
    process.stdout.write(run({ file: process.execPath, prefix: [] }, ['imports.mjs'], dir));

    typeCheckFiles(dir, packed);
    const tsc = {
      file: process.execPath,
      prefix: [join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')],
    };
    for (const resolution of ['NodeNext', 'Bundler'] as const) {
      write(dir, 'tsconfig.json', tsconfig(resolution));
      run(tsc, ['-p', 'tsconfig.json'], dir);
      console.log(`smoke: types ok (moduleResolution ${resolution})`);
    }

    write(dir, 'ssr.mjs', SSR_CHECK);
    process.stdout.write(run({ file: process.execPath, prefix: [] }, ['ssr.mjs'], dir));
    console.log('smoke: ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
