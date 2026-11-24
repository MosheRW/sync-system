// Unit tests of the pure release checks (#37 AC50, AC51, C4, C6, C10, L10;
// #53 ADR 0020 R2, L4; #63 ADR 0021 R1, R2), and the pnpmfile route
// integration test (#63 R3, R4).
// Run with Node's built-in runner: node --test "scripts/release/*.test.ts".
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  PACK_ARGS,
  packOne,
  pnpmCommand,
  readManifest,
  readTarball,
  repoRoot,
  run,
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

  // #63, ADR 0021 (R2): pnpm reads the dashed form of the env name too.
  for (const name of [
    'npm_config_global-pnpmfile',
    'NPM_CONFIG_GLOBAL-PNPMFILE',
    'Npm_Config_Global-Pnpmfile',
  ]) {
    it(`rejects the dashed ${name}`, () => {
      withRoot((root) => {
        const problems = checkNoPnpmfile(root, { [name]: '/tmp/hook.cjs' });
        assert.equal(problems.length, 1);
        assert.match(problems[0] ?? '', /is set; no pnpmfile is allowed \(#53, ADR 0020\)/);
        assert.ok((problems[0] ?? '').startsWith(`${name} is set`));
      });
    });
  }

  for (const name of ['npm_config_ignore_pnpmfile', 'npm_config_ignore-pnpmfile']) {
    it(`does not reject ${name}`, () => {
      withRoot((root) => assert.deepEqual(checkNoPnpmfile(root, { [name]: 'true' }), []));
    });
  }

  it('accepts the real repo root', () => {
    assert.deepEqual(checkNoPnpmfile(repoRoot, {}), []);
  });
});

describe('PACK_ARGS (#63, ADR 0021, R1)', () => {
  it('packs with pnpmfiles ignored, as a command-line setting', () => {
    assert.equal(PACK_ARGS[0], 'pack');
    assert.ok(PACK_ARGS.includes('--config.ignore-pnpmfile=true'));
  });

  it('uses no form pnpm 10.28.0 rejects and nothing that turns the setting off', () => {
    assert.ok(!PACK_ARGS.includes('--ignore-pnpmfile'));
    assert.equal(PACK_ARGS.filter((arg) => arg.includes('ignore-pnpmfile')).length, 1);
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

// ---------------------------------------------------------------------------
// #63, ADR 0021 (R3, R4): every route by which pnpm 10 loads a pnpmfile. Each
// case packs one throwaway workspace twice: plain `pnpm pack` first (the hook
// must apply, which proves the route is live), then the production `packOne`
// (the hook must not apply). A pnpm upgrade that drops or renames
// `ignore-pnpmfile` fails the second half. No dependencies, and config
// dependencies are pre-placed so pnpm skips the fetch.
//
// The fixture lives under os.tmpdir(), outside the repo, so it carries the
// repo's own `packageManager` value, copied verbatim (sha512 included, so
// corepack verifies any download). Without it, a bare `node --test` on Linux
// resolves `pnpm` from PATH; after `corepack enable` that is the corepack
// shim, which falls back to its own default pnpm (pnpm 12 in the node:24
// image) and tests routes against a pnpm the repo does not use (#67). Through
// `pnpm test`, `npm_execpath` already is the pinned pnpm and the field is a
// no-op. The pinned pnpm must be in the corepack cache for an offline run (it
// is after `corepack enable` and `pnpm install`, RELEASING.md step 2).

const FIXTURE_NAME = '@x/a';
const FIXTURE_TARBALL = tarballName(FIXTURE_NAME, '1.0.0');

/** The root `packageManager`, verbatim; throws (never skips) if it is not a pnpm pin. */
function pinnedPackageManager(): string {
  const value = readManifest('.')['packageManager'];
  if (typeof value !== 'string' || !value.startsWith('pnpm@')) {
    throw new Error(
      `root package.json packageManager must pin pnpm (pnpm@<version>+sha512.<hash>), got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** pnpm through the same lookup the release scripts use; undefined if absent. */
function findPnpm(): ReturnType<typeof pnpmCommand> | undefined {
  try {
    const pnpm = pnpmCommand();
    execFileSync(pnpm.file, [...pnpm.prefix, '--version'], { stdio: 'ignore' });
    return pnpm;
  } catch {
    return undefined;
  }
}

const PNPM = findPnpm();

/** R3: the inherited env without anything that names or disables a pnpmfile. */
function scrubbedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/pnpmfile|userconfig|globalconfig/i.test(key) || key === 'XDG_CONFIG_HOME') continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

/** A hook that appends `label` to `hookedBy` in the packed package.json. */
function hookSource(label: string): string {
  return [
    'module.exports = {',
    '  hooks: {',
    '    beforePacking(pkg) {',
    `      pkg.hookedBy = (pkg.hookedBy || []).concat(${JSON.stringify(label)});`,
    '      return pkg;',
    '    },',
    '  },',
    '};',
    '',
  ].join('\n');
}

/** Forward slashes, so a Windows path reads the same in .npmrc and YAML. */
function slashed(path: string): string {
  return path.replaceAll('\\', '/');
}

interface Fixture {
  /** The workspace root. */
  root: string;
  /** A scratch directory outside the workspace root. */
  outside: string;
  /** Writes a hook file outside the workspace root and returns its path. */
  hook(label: string): string;
  /** Writes a file relative to the workspace root. */
  write(path: string, text: string): void;
  rootManifest: Record<string, unknown>;
  workspaceYaml: string[];
}

interface RouteCase {
  name: string;
  label: string;
  /** Sets the route up; returns the case's own env keys. */
  setup(fixture: Fixture): Record<string, string>;
}

/** Places a config-dependency plugin so pnpm loads its pnpmfile.cjs offline. */
function plugin(fixture: Fixture, name: string, label: string): string {
  const dir = join(fixture.root, 'node_modules', '.pnpm-config', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  writeFileSync(join(dir, 'pnpmfile.cjs'), hookSource(label));
  // With the directory in place pnpm checks only name and version (no fetch).
  return `1.0.0+sha512-${Buffer.alloc(64).toString('base64')}`;
}

/** An rc file outside the workspace that sets `pnpmfile`. */
function rcFile(fixture: Fixture, path: string, label: string): string {
  const file = join(fixture.outside, path);
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `pnpmfile=${slashed(fixture.hook(label))}\n`);
  return file;
}

const ROUTES: RouteCase[] = [
  {
    name: 'root .pnpmfile.cjs',
    label: 'root',
    setup: (f) => {
      f.write('.pnpmfile.cjs', hookSource('root'));
      return {};
    },
  },
  {
    name: '.npmrc pnpmfile',
    label: 'npmrc',
    setup: (f) => {
      f.write('.npmrc', `pnpmfile=${slashed(f.hook('npmrc'))}\n`);
      return {};
    },
  },
  {
    name: '.npmrc global-pnpmfile',
    label: 'npmrc-global',
    setup: (f) => {
      f.write('.npmrc', `global-pnpmfile=${slashed(f.hook('npmrc-global'))}\n`);
      return {};
    },
  },
  {
    name: 'pnpm-workspace.yaml pnpmfile',
    label: 'yaml',
    setup: (f) => {
      f.workspaceYaml.push(`pnpmfile: ${JSON.stringify(slashed(f.hook('yaml')))}`);
      return {};
    },
  },
  {
    name: 'pnpm-workspace.yaml globalPnpmfile',
    label: 'yaml-global',
    setup: (f) => {
      f.workspaceYaml.push(`globalPnpmfile: ${JSON.stringify(slashed(f.hook('yaml-global')))}`);
      return {};
    },
  },
  {
    name: 'pnpm-workspace.yaml configDependencies pnpm-plugin-*',
    label: 'plugin',
    setup: (f) => {
      const spec = plugin(f, 'pnpm-plugin-evil', 'plugin');
      f.workspaceYaml.push('configDependencies:', `  pnpm-plugin-evil: ${JSON.stringify(spec)}`);
      return {};
    },
  },
  {
    name: 'pnpm-workspace.yaml configDependencies @pnpm/plugin-*',
    label: 'scoped-plugin',
    setup: (f) => {
      const spec = plugin(f, '@pnpm/plugin-evil', 'scoped-plugin');
      f.workspaceYaml.push('configDependencies:', `  '@pnpm/plugin-evil': ${JSON.stringify(spec)}`);
      return {};
    },
  },
  {
    name: 'package.json pnpm.configDependencies pnpm-plugin-*',
    label: 'manifest-plugin',
    setup: (f) => {
      const spec = plugin(f, 'pnpm-plugin-evil', 'manifest-plugin');
      f.rootManifest['pnpm'] = { configDependencies: { 'pnpm-plugin-evil': spec } };
      return {};
    },
  },
  {
    name: 'env npm_config_pnpmfile',
    label: 'env-plain',
    setup: (f) => ({ npm_config_pnpmfile: f.hook('env-plain') }),
  },
  {
    name: 'env npm_config_global-pnpmfile (dashed)',
    label: 'env-dashed',
    setup: (f) => ({ 'npm_config_global-pnpmfile': f.hook('env-dashed') }),
  },
  {
    name: 'env npm_config_userconfig',
    label: 'userconfig',
    setup: (f) => ({ npm_config_userconfig: rcFile(f, 'user.rc', 'userconfig') }),
  },
  {
    name: 'env npm_config_globalconfig',
    label: 'globalconfig',
    setup: (f) => ({ npm_config_globalconfig: rcFile(f, 'global.rc', 'globalconfig') }),
  },
  {
    name: 'env XDG_CONFIG_HOME pnpm/rc',
    label: 'xdg',
    setup: (f) => {
      rcFile(f, join('xdg', 'pnpm', 'rc'), 'xdg');
      return { XDG_CONFIG_HOME: join(f.outside, 'xdg') };
    },
  },
];

/** Builds the fixture for one case under `base`; returns the package dir and env. */
function buildFixture(base: string, route: RouteCase): { pkgDir: string; env: NodeJS.ProcessEnv } {
  const root = join(base, 'ws');
  const outside = join(base, 'outside');
  const pkgDir = join(root, 'packages', 'a');
  mkdirSync(pkgDir, { recursive: true });
  mkdirSync(join(outside, 'hooks'), { recursive: true });
  const fixture: Fixture = {
    root,
    outside,
    hook(label) {
      const path = join(outside, 'hooks', `${label}.cjs`);
      writeFileSync(path, hookSource(label));
      return path;
    },
    write(path, text) {
      writeFileSync(join(root, path), text);
    },
    rootManifest: {
      name: 'fixture-root',
      version: '0.0.0',
      private: true,
      packageManager: pinnedPackageManager(),
    },
    workspaceYaml: ['packages:', "  - 'packages/*'"],
  };
  const extra = route.setup(fixture);
  writeFileSync(join(root, 'package.json'), JSON.stringify(fixture.rootManifest, null, 2));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), `${fixture.workspaceYaml.join('\n')}\n`);
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: FIXTURE_NAME, version: '1.0.0', files: ['index.js'] }, null, 2),
  );
  writeFileSync(join(pkgDir, 'index.js'), 'export {};\n');
  return { pkgDir, env: scrubbedEnv(extra) };
}

/** `hookedBy` of the packed package.json in `dir`. */
function hookedBy(dir: string): unknown {
  const entries = readTarball(readFileSync(join(dir, FIXTURE_TARBALL)));
  const packed = entries.find((e) => e.path === 'package/package.json');
  assert.ok(packed, 'packed package.json');
  return (JSON.parse(packed.content.toString('utf8')) as Manifest)['hookedBy'];
}

// R4: skip only outside CI (for example a bare `node --test` on Windows).
const skipRoutes =
  PNPM === undefined && process.env['CI'] !== 'true'
    ? 'pnpm not found; run through `pnpm test`'
    : false;

describe('packing ignores every pnpmfile route (#63, ADR 0021, R3)', { skip: skipRoutes }, () => {
  it('finds pnpm (R4: fails instead of skipping with CI=true)', () => {
    assert.ok(PNPM, 'pnpm not found; the route test must run in CI');
  });

  // #67: both halves of every case resolve pnpm exactly like this (fixture
  // cwd, scrubbed env). A different pnpm fails here with one clear message
  // instead of a dozen confusing positive-control failures below.
  it('runs the pinned pnpm in the fixtures (#67)', () => {
    assert.ok(PNPM, 'pnpm not found');
    const pinned = pinnedPackageManager().slice('pnpm@'.length).split('+')[0];
    const base = mkdtempSync(join(tmpdir(), 'sync-pnpmfile-version-'));
    try {
      const { pkgDir, env } = buildFixture(base, {
        name: 'pnpm version',
        label: 'version',
        setup: () => ({}),
      });
      const actual = run(PNPM, ['--version'], pkgDir, env).trim();
      assert.equal(
        actual,
        pinned,
        `pnpm ${actual} runs the route fixtures, but the repo pins ${pinned} (packageManager); ` +
          'run through `pnpm test`, or `corepack enable` so the shim honours the fixture packageManager',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  for (const route of ROUTES) {
    it(route.name, () => {
      assert.ok(PNPM, 'pnpm not found');
      const base = mkdtempSync(join(tmpdir(), 'sync-pnpmfile-route-'));
      try {
        const { pkgDir, env } = buildFixture(base, route);
        const plain = join(base, 'plain');
        const guarded = join(base, 'guarded');
        mkdirSync(plain);
        mkdirSync(guarded);
        // Positive control: the route is live, so plain `pnpm pack` applies the hook.
        run(PNPM, ['pack', '--pack-destination', plain], pkgDir, env);
        const control = hookedBy(plain);
        assert.ok(
          Array.isArray(control) && control.includes(route.label),
          `positive control: expected ${route.label} in ${JSON.stringify(control)}`,
        );
        // Production: the same fixture packed through packOne gets no hook.
        packOne(pkgDir, guarded, env);
        assert.equal(hookedBy(guarded), undefined);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// #63 (security A1): `pnpm pack:check` fails closed early when `.npmrc` or
// `pnpm-workspace.yaml` sets `pnpmfile`, because `pnpm run` exports the
// setting to the script as `npm_config_pnpmfile` and checkNoPnpmfile rejects
// that env. If a pnpm upgrade stops exporting it, this test fails, so the
// early warning documented in RELEASING.md cannot vanish unnoticed. The
// control case (no setting) proves the child env is clean otherwise.
//
// The fixture script dumps only the `npm_config_*` keys (name compared in
// lower case with `-` read as `_`, as checkNoPnpmfile does), never the whole
// env: a CI runner's env can hold tokens, and a crash before the `finally`
// cleanup would leave them on disk (#63, security A3). Every name the guard
// inspects (PNPMFILE_ENV in lib.ts) has that prefix, so the filter cannot
// hide a key from it.

const DUMP_ENV = [
  'const env = {};',
  'for (const [k, v] of Object.entries(process.env)) {',
  "  if (k.toLowerCase().replaceAll('-', '_').startsWith('npm_config_')) env[k] = v;",
  '}',
  "require('node:fs').writeFileSync('env.json', JSON.stringify(env));",
  '',
].join('\n');

const RUN_ENV_CASES: { name: string; set: boolean; setup(fixture: Fixture): void }[] = [
  { name: 'no pnpmfile setting (control)', set: false, setup: () => undefined },
  {
    name: '.npmrc pnpmfile',
    set: true,
    setup: (f) => f.write('.npmrc', `pnpmfile=${slashed(f.hook('npmrc'))}\n`),
  },
  {
    name: 'pnpm-workspace.yaml pnpmfile',
    set: true,
    setup: (f) => {
      f.workspaceYaml.push(`pnpmfile: ${JSON.stringify(slashed(f.hook('yaml')))}`);
    },
  },
];

describe(
  'pnpm run exports a configured pnpmfile to the guard (#63, A1)',
  { skip: skipRoutes },
  () => {
    for (const runCase of RUN_ENV_CASES) {
      it(runCase.name, () => {
        assert.ok(PNPM, 'pnpm not found');
        const base = mkdtempSync(join(tmpdir(), 'sync-pnpmfile-run-'));
        try {
          const { env } = buildFixture(base, {
            name: runCase.name,
            label: 'run',
            setup: (f) => {
              runCase.setup(f);
              f.rootManifest['scripts'] = { 'dump-env': 'node dump-env.cjs' };
              f.write('dump-env.cjs', DUMP_ENV);
              return {};
            },
          });
          const root = join(base, 'ws');
          run(PNPM, ['run', 'dump-env'], root, env);
          const childEnv = JSON.parse(
            readFileSync(join(root, 'env.json'), 'utf8'),
          ) as NodeJS.ProcessEnv;
          const keys = Object.keys(childEnv);
          assert.ok(keys.length > 0, 'pnpm run exports npm_config_* keys to the script');
          assert.deepEqual(
            keys.filter((k) => !k.toLowerCase().replaceAll('-', '_').startsWith('npm_config_')),
            [],
            'the dump holds only npm_config_* keys',
          );
          const problems = checkNoPnpmfile(root, childEnv);
          if (runCase.set) {
            assert.ok(childEnv['npm_config_pnpmfile'], 'pnpm run exports npm_config_pnpmfile');
            assert.ok(
              problems.some((p) => p.startsWith('npm_config_pnpmfile is set')),
              `guard rejects it: ${JSON.stringify(problems)}`,
            );
          } else {
            assert.equal(childEnv['npm_config_pnpmfile'], undefined);
            assert.deepEqual(problems, []);
          }
        } finally {
          rmSync(base, { recursive: true, force: true });
        }
      });
    }
  },
);
