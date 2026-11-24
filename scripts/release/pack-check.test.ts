// Unit tests of the pure release checks (#37 AC50, AC51, C4, C6, C10, L10;
// #53 ADR 0020 R2, L4).
// Run with Node's built-in runner: node --test "scripts/release/*.test.ts".
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  checkEntries,
  checkManifest,
  checkNoPnpmfile,
  checkPublishableSet,
  checkSameVersion,
  checkWorkspaceRanges,
  integrityLine,
  readTarball,
  repoRoot,
  tarballName,
  workspacePackages,
  type Manifest,
  type TarEntry,
  type WorkspacePackage,
} from './lib.ts';
import { SMOKE_INSTALL_ARGS, exactVersions, exportedNames } from './smoke.ts';

const NAME = '@mosherw/sync-system-client';

function file(path: string): TarEntry {
  return { path, type: '0', content: Buffer.alloc(0) };
}

const GOOD_ENTRIES: TarEntry[] = [
  file('package/package.json'),
  file('package/README.md'),
  file('package/LICENSE'),
  file('package/CHANGELOG.md'),
  file('package/dist/index.js'),
  file('package/dist/index.js.map'),
  file('package/dist/index.d.ts'),
  file('package/dist/index.d.ts.map'),
  file('package/dist/hooks/group.js'),
];

function goodManifest(): Manifest {
  return {
    name: NAME,
    version: '1.0.0',
    license: 'GPL-3.0-only',
    repository: {
      type: 'git',
      url: 'git+https://example.invalid/x.git',
      directory: 'packages/client',
    },
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    dependencies: { '@mosherw/sync-system-protocol': '1.0.0' },
    scripts: { build: 'tsc', test: 'vitest run', typecheck: 'tsc' },
  };
}

describe('checkEntries (allow-list)', () => {
  it('accepts the build output, README, changelog and license', () => {
    assert.deepEqual(checkEntries(GOOD_ENTRIES), []);
  });

  for (const path of [
    'package/src/index.ts',
    'package/test/a.test.ts',
    'package/.env',
    'package/.npmrc',
    'package/tsconfig.json',
    'package/dist/secret.json',
    'package/config/apps.json',
  ]) {
    it(`rejects ${path}`, () => {
      const problems = checkEntries([...GOOD_ENTRIES, file(path)]);
      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? '', /not in the allow-list/);
    });
  }

  it('rejects a symlink even with an allowed name', () => {
    const link: TarEntry = { path: 'package/dist/index2.js', type: '2', content: Buffer.alloc(0) };
    assert.match(checkEntries([...GOOD_ENTRIES, link]).join(), /not a regular file/);
  });

  it('requires the license, README and entry files', () => {
    const problems = checkEntries([file('package/package.json')]);
    for (const missing of ['README.md', 'LICENSE', 'dist/index.js', 'dist/index.d.ts']) {
      assert.ok(
        problems.some((p) => p.includes(missing) && p.endsWith('missing')),
        missing,
      );
    }
  });
});

describe('checkManifest', () => {
  it('accepts a public-ready manifest with build/test scripts', () => {
    assert.deepEqual(checkManifest(goodManifest(), NAME), []);
  });

  it('rejects private, workspace ranges, the source condition and a wrong license', () => {
    const bad: Manifest = {
      ...goodManifest(),
      private: true,
      license: 'MIT',
      dependencies: { '@mosherw/sync-system-protocol': 'workspace:*' },
      exports: { '.': { '@mosherw/sync-system-source': './src/index.ts' } },
    };
    const problems = checkManifest(bad, NAME).join('\n');
    assert.match(problems, /private/);
    assert.match(problems, /workspace: range/);
    assert.match(problems, /sync-system-source/);
    assert.match(problems, /license/);
  });

  it('rejects a missing repository.directory and a wrong name', () => {
    const problems = checkManifest({ ...goodManifest(), repository: {} }, '@mosherw/other');
    assert.equal(problems.length, 2);
  });

  // L10: every lifecycle hook npm or pnpm may run.
  for (const script of [
    'preinstall',
    'install',
    'postinstall',
    'prepare',
    'preprepare',
    'postprepare',
    'prepublish',
    'prepublishOnly',
    'publish',
    'postpublish',
    'prepack',
    'pack',
    'postpack',
    'preversion',
    'version',
    'postversion',
    'dependencies',
  ]) {
    it(`rejects the lifecycle script ${script}`, () => {
      const manifest = { ...goodManifest(), scripts: { build: 'tsc', [script]: 'node x.js' } };
      assert.deepEqual(checkManifest(manifest, NAME), [`has the lifecycle script ${script}`]);
    });
  }
});

describe('checkSameVersion', () => {
  it('accepts one version and rejects two', () => {
    assert.deepEqual(checkSameVersion([{ version: '1.0.0' }, { version: '1.0.0' }]), []);
    assert.equal(checkSameVersion([{ version: '1.0.0' }, { version: '1.0.1' }]).length, 1);
  });
});

describe('checkPublishableSet (C4)', () => {
  function workspace(): WorkspacePackage[] {
    return [
      { dir: '.', manifest: { name: 'sync-system', private: true } },
      { dir: 'packages/protocol', manifest: { name: '@mosherw/sync-system-protocol' } },
      { dir: 'packages/client', manifest: { name: '@mosherw/sync-system-client' } },
      { dir: 'packages/react', manifest: { name: '@mosherw/sync-system-react' } },
      { dir: 'apps/sync-server', manifest: { name: '@mosherw/sync-system-server', private: true } },
      { dir: 'apps/reader', manifest: { name: '@mosherw/sync-system-reader', private: true } },
    ];
  }

  it('accepts exactly the three published packages', () => {
    assert.deepEqual(checkPublishableSet(workspace()), []);
  });

  for (const dir of ['.', 'apps/sync-server', 'apps/reader']) {
    it(`fails when ${dir} drops private: true`, () => {
      const packages = workspace().map((p) =>
        p.dir === dir ? { dir, manifest: { name: p.manifest.name } } : p,
      );
      assert.ok(checkPublishableSet(packages).length >= 1);
    });
  }

  it('fails on an extra non-private package', () => {
    const packages = [
      ...workspace(),
      { dir: 'packages/extra', manifest: { name: '@mosherw/sync-system-extra' } },
    ];
    assert.match(checkPublishableSet(packages).join(), /publishable packages/);
  });
});

describe('checkWorkspaceRanges (#53, ADR 0020, R2)', () => {
  function workspace(): WorkspacePackage[] {
    return [
      { dir: '.', manifest: { name: 'sync-system', private: true } },
      { dir: 'packages/protocol', manifest: { name: '@mosherw/sync-system-protocol' } },
      {
        dir: 'packages/client',
        manifest: {
          name: '@mosherw/sync-system-client',
          dependencies: { '@mosherw/sync-system-protocol': 'workspace:*' },
          devDependencies: { '@mosherw/sync-system-server': 'workspace:*', vitest: '^4' },
        },
      },
      {
        dir: 'packages/react',
        manifest: {
          name: '@mosherw/sync-system-react',
          dependencies: { '@mosherw/sync-system-client': 'workspace:*' },
          peerDependencies: { react: '^18.3 || ^19' },
          devDependencies: { '@mosherw/sync-system-server': 'workspace:*', react: '^19' },
        },
      },
      {
        dir: 'apps/sync-server',
        manifest: {
          name: '@mosherw/sync-system-server',
          private: true,
          dependencies: { a: 'workspace:*', b: 'workspace:^' },
        },
      },
    ];
  }

  function withReact(extra: Manifest): WorkspacePackage[] {
    return workspace().map((p) =>
      p.dir === 'packages/react' ? { dir: p.dir, manifest: { ...p.manifest, ...extra } } : p,
    );
  }

  it('accepts one workspace: range per map and ignores private packages', () => {
    assert.deepEqual(checkWorkspaceRanges(workspace()), []);
  });

  it('rejects two workspace: ranges in devDependencies, naming #53 and ADR 0020', () => {
    const problems = checkWorkspaceRanges(
      withReact({
        devDependencies: {
          '@mosherw/sync-system-protocol': 'workspace:*',
          '@mosherw/sync-system-server': 'workspace:*',
        },
      }),
    );
    assert.equal(problems.length, 1);
    const [problem = ''] = problems;
    assert.match(problem, /^packages\/react: devDependencies has 2 workspace: ranges/);
    assert.match(problem, /@mosherw\/sync-system-protocol, @mosherw\/sync-system-server/);
    assert.match(problem, /#53/);
    assert.match(problem, /ADR 0020/);
  });

  it('rejects two in peerDependencies, a compound peer range included', () => {
    const problems = checkWorkspaceRanges(
      withReact({
        peerDependencies: {
          react: '^18.3 || ^19',
          '@mosherw/sync-system-client': '^1 || workspace:^',
          '@mosherw/sync-system-protocol': 'workspace:~',
        },
      }),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /peerDependencies has 2 workspace: ranges/);
  });

  it('checks optionalDependencies and dependencies too', () => {
    for (const field of ['optionalDependencies', 'dependencies']) {
      const problems = checkWorkspaceRanges(
        withReact({ [field]: { a: 'workspace:*', b: 'workspace:../b' } }),
      );
      assert.equal(problems.length, 1, field);
      assert.match(problems[0] ?? '', new RegExp(`${field} has 2`));
    }
  });

  it('reports a missing published package', () => {
    const packages = workspace().filter((p) => p.dir !== 'packages/protocol');
    assert.match(checkWorkspaceRanges(packages).join(), /packages\/protocol: .*not found/);
  });

  it('reports a published dir with another name', () => {
    const packages = workspace().map((p) =>
      p.dir === 'packages/protocol' ? { dir: p.dir, manifest: { name: '@mosherw/other' } } : p,
    );
    assert.match(
      checkWorkspaceRanges(packages).join(),
      /packages\/protocol: name is @mosherw\/other/,
    );
  });

  for (const value of [null, ['workspace:*', 'workspace:*'], 'workspace:*', 1]) {
    it(`reports a dependency field that is not a plain object: ${JSON.stringify(value)}`, () => {
      const problems = checkWorkspaceRanges(withReact({ devDependencies: value }));
      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? '', /packages\/react: devDependencies is not an object/);
    });
  }

  it('accepts the real workspace', () => {
    assert.deepEqual(checkWorkspaceRanges(workspacePackages()), []);
  });
});

describe('checkNoPnpmfile (#53, ADR 0020, L4)', () => {
  function withRoot(test: (root: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), 'sync-pnpmfile-'));
    try {
      test(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('accepts a root without a pnpmfile and no pnpmfile setting', () => {
    withRoot((root) => assert.deepEqual(checkNoPnpmfile(root, {}), []));
  });

  it('rejects a root .pnpmfile.cjs', () => {
    withRoot((root) => {
      writeFileSync(join(root, '.pnpmfile.cjs'), 'module.exports = {};\n');
      const problems = checkNoPnpmfile(root, {});
      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? '', /\.pnpmfile\.cjs exists/);
    });
  });

  for (const name of [
    'npm_config_pnpmfile',
    'npm_config_global_pnpmfile',
    'NPM_CONFIG_PNPMFILE',
    'NPM_CONFIG_GLOBAL_PNPMFILE',
  ]) {
    for (const value of ['hook.cjs', '']) {
      it(`rejects ${name}=${JSON.stringify(value)}`, () => {
        withRoot((root) => {
          const problems = checkNoPnpmfile(root, { [name]: value });
          assert.equal(problems.length, 1);
          assert.match(problems[0] ?? '', new RegExp(`${name} is set`));
        });
      });
    }
  }

  it('accepts the real repo root', () => {
    assert.deepEqual(checkNoPnpmfile(repoRoot, {}), []);
  });
});

describe('tarballs and integrity', () => {
  it('names tarballs like pnpm pack', () => {
    assert.equal(tarballName(NAME, '1.0.0'), 'mosherw-sync-system-client-1.0.0.tgz');
  });

  it('writes integrity lines in npm dist.integrity format', () => {
    const bytes = Buffer.from('abc');
    const expected = createHash('sha512').update(bytes).digest('base64');
    assert.equal(integrityLine('a.tgz', bytes), `a.tgz sha512-${expected}`);
    assert.match(integrityLine('a.tgz', bytes), /^a\.tgz sha512-[A-Za-z0-9+/]{86}==$/);
  });

  it('reads ustar entries, types and contents', () => {
    function header(name: string, type: string, size: number): Buffer {
      const block = Buffer.alloc(512);
      block.write(name, 0, 'utf8');
      block.write(size.toString(8).padStart(11, '0'), 124, 'latin1');
      block.write(type, 156, 'latin1');
      block.write('ustar\0', 257, 'latin1');
      return block;
    }
    const body = Buffer.alloc(512);
    body.write('{"name":"x"}');
    const tar = Buffer.concat([
      header('package/package.json', '0', 12),
      body,
      header('package/link', '2', 0),
      Buffer.alloc(1024),
    ]);
    const entries = readTarball(gzipSync(tar));
    assert.deepEqual(
      entries.map((e) => [e.path, e.type]),
      [
        ['package/package.json', '0'],
        ['package/link', '2'],
      ],
    );
    assert.equal(entries[0]?.content.toString(), '{"name":"x"}');
  });
});

describe('smoke helpers (C6)', () => {
  it('installs with --ignore-scripts and prefers the local store', () => {
    assert.ok(SMOKE_INSTALL_ARGS.includes('--ignore-scripts'));
    assert.ok(SMOKE_INSTALL_ARGS.includes('--prefer-offline'));
  });

  const listed = (react: unknown) =>
    JSON.stringify([
      {
        name: '@mosherw/sync-system-react',
        devDependencies: {
          react: { version: react },
          'react-dom': { version: '19.3.1' },
          '@types/react': { version: '19.3.0' },
          '@types/react-dom': { version: '19.3.0' },
        },
      },
    ]);

  it('takes the exact lockfile versions', () => {
    assert.deepEqual(exactVersions(listed('19.3.1')), {
      react: '19.3.1',
      'react-dom': '19.3.1',
      '@types/react': '19.3.0',
      '@types/react-dom': '19.3.0',
    });
  });

  for (const range of ['^19.3.1', '~19.3.1', '19', '>=19.0.0', 'latest', undefined]) {
    it(`refuses a range or missing version: ${String(range)}`, () => {
      assert.throws(() => exactVersions(listed(range)), /no exact version/);
    });
  }

  it('lists the names a dist/index.d.ts exports', () => {
    const dts = [
      "export { SyncProvider } from './provider.js';",
      "export type { SyncProviderProps, Other as Renamed } from './provider.js';",
      "export { a, type B } from './x.js';",
    ].join('\n');
    assert.deepEqual(exportedNames(dts), [
      'B',
      'Renamed',
      'SyncProvider',
      'SyncProviderProps',
      'a',
    ]);
  });
});
