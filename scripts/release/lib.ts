// Shared helpers for the release scripts (#37, ADR 0016). Node built-ins only.
// Every child process gets an argument array, never a shell string.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface PublishedPackage {
  name: string;
  dir: string;
}

/** The published packages, in publish order (a dependency before its dependents). */
export const PUBLISHED: readonly PublishedPackage[] = [
  { name: '@mosherw/sync-system-protocol', dir: 'packages/protocol' },
  { name: '@mosherw/sync-system-client', dir: 'packages/client' },
  { name: '@mosherw/sync-system-react', dir: 'packages/react' },
];

/** Workspace packages that must stay `private: true` ('.' is the root). */
export const PRIVATE_DIRS: readonly string[] = ['.', 'apps/sync-server', 'apps/reader'];

export const SOURCE_CONDITION = '@mosherw/sync-system-source';

export interface Manifest {
  name?: unknown;
  version?: unknown;
  private?: unknown;
  license?: unknown;
  repository?: unknown;
  scripts?: unknown;
  [key: string]: unknown;
}

export interface WorkspacePackage {
  dir: string;
  manifest: Manifest;
}

export function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8')) as Manifest;
}

/** The root and every `apps/*` and `packages/*` directory with a package.json. */
export function workspacePackages(): WorkspacePackage[] {
  const dirs = ['apps', 'packages'].flatMap((parent) =>
    readdirSync(join(repoRoot, parent))
      .map((name) => `${parent}/${name}`)
      .filter((dir) => existsSync(join(repoRoot, dir, 'package.json'))),
  );
  return ['.', ...dirs].map((dir) => ({ dir, manifest: readManifest(dir) }));
}

/**
 * C4 (security M3): the non-private workspace packages are exactly the
 * published names, and root, server and reader are `private: true`.
 */
export function checkPublishableSet(packages: readonly WorkspacePackage[]): string[] {
  const problems: string[] = [];
  const expected = PUBLISHED.map((p) => p.name).sort();
  const publishable = packages
    .filter((p) => p.manifest.private !== true)
    .map((p) => String(p.manifest.name))
    .sort();
  if (JSON.stringify(publishable) !== JSON.stringify(expected)) {
    problems.push(
      `publishable packages are [${publishable.join(', ')}], expected [${expected.join(', ')}]`,
    );
  }
  for (const dir of PRIVATE_DIRS) {
    const found = packages.find((p) => p.dir === dir);
    if (found === undefined) {
      problems.push(`${dir}: package.json not found`);
    } else if (found.manifest.private !== true) {
      problems.push(`${dir}: must be private: true`);
    }
  }
  return problems;
}

/**
 * #53, ADR 0020 (R2): at most one `workspace:` range per dependency map in each
 * published package's source manifest. pnpm 10 converts those ranges with a
 * disk read each and inserts the keys in completion order, so two or more in
 * one map give a racy key order in the packed package.json. Counts every value
 * that contains `workspace:` (pnpm's peer converter uses `includes`, so
 * `"^1 || workspace:^"` counts). Fails closed: a missing published package or
 * a dependency field that is not a plain object is a problem too.
 */
export function checkWorkspaceRanges(packages: readonly WorkspacePackage[]): string[] {
  const problems: string[] = [];
  for (const pkg of PUBLISHED) {
    const found = packages.find((p) => p.dir === pkg.dir);
    if (found === undefined) {
      problems.push(`${pkg.dir}: published package not found`);
      continue;
    }
    if (found.manifest.name !== pkg.name) {
      problems.push(`${pkg.dir}: name is ${String(found.manifest.name)}, expected ${pkg.name}`);
    }
    for (const key of DEPENDENCY_FIELDS) {
      const deps = found.manifest[key];
      if (deps === undefined) continue;
      if (typeof deps !== 'object' || deps === null || Array.isArray(deps)) {
        problems.push(`${pkg.dir}: ${key} is not an object`);
        continue;
      }
      const names = Object.entries(deps as Record<string, unknown>)
        .filter(([, range]) => String(range).includes('workspace:'))
        .map(([name]) => name);
      if (names.length >= 2) {
        problems.push(
          `${pkg.dir}: ${key} has ${names.length} workspace: ranges (${names.join(', ')}); ` +
            'pnpm 10 packs them in a racy order (#53, ADR 0020)',
        );
      }
    }
  }
  return problems;
}

/**
 * Settings that make pnpm load a pnpmfile. Env names are compared in lower
 * case with `-` read as `_` (#63, ADR 0021 R2): pnpm reads
 * `npm_config_global-pnpmfile` as well as `npm_config_global_pnpmfile`.
 */
const PNPMFILE_ENV = ['npm_config_pnpmfile', 'npm_config_global_pnpmfile'];

/**
 * #53, ADR 0020 (L4, R7): no pnpmfile. Its `beforePacking` hook could rewrite
 * the packed package.json after every source-level check. This is the early,
 * loud signal for the common cases; the pack itself ignores every pnpmfile
 * (`PACK_ARGS`, #63, ADR 0021), including routes this check does not read
 * (`.npmrc`, `pnpm-workspace.yaml`, config-dependency plugins, user rc files).
 */
export function checkNoPnpmfile(root: string, env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  if (existsSync(join(root, '.pnpmfile.cjs'))) {
    problems.push('.pnpmfile.cjs exists at the repo root; no pnpmfile is allowed (#53, ADR 0020)');
  }
  for (const name of Object.keys(env)) {
    const normalised = name.toLowerCase().replaceAll('-', '_');
    if (PNPMFILE_ENV.includes(normalised) && env[name] !== undefined) {
      problems.push(`${name} is set; no pnpmfile is allowed (#53, ADR 0020)`);
    }
  }
  return problems;
}

/** The file name `pnpm pack` gives a package: `@scope/name` 1.2.3 -> `scope-name-1.2.3.tgz`. */
export function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
}

/** `sha512-<base64>` of `bytes`, the format of npm's `dist.integrity` (#92). */
export function sha512Integrity(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/** `<file> sha512-<base64>`, the format of npm's `dist.integrity`. */
export function integrityLine(file: string, bytes: Buffer): string {
  return `${file} ${sha512Integrity(bytes)}`;
}

// ---------------------------------------------------------------------------
// Tarball contents

export interface TarEntry {
  path: string;
  /** '0' regular file, '5' directory, '2' symlink, '1' hard link, ... */
  type: string;
  content: Buffer;
}

function field(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

/** Minimal reader for the gzip'd ustar files `pnpm pack` writes (pax paths included). */
export function readTarball(gz: Buffer): TarEntry[] {
  const tar = gunzipSync(gz);
  const entries: TarEntry[] = [];
  let offset = 0;
  let nextPath: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(field(header, 124, 12).trim() || '0', 8);
    const typeChar = field(header, 156, 1) || '0';
    const prefix = header.subarray(257, 263).toString('latin1').startsWith('ustar')
      ? field(header, 345, 155)
      : '';
    const name = field(header, 0, 100);
    const content = Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
    if (typeChar === 'x') {
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(content.toString('utf8'));
      if (match?.[1] !== undefined) nextPath = match[1];
      continue;
    }
    if (typeChar === 'L') {
      nextPath = content.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeChar === 'g') continue;
    const path = nextPath ?? (prefix === '' ? name : `${prefix}/${name}`);
    nextPath = undefined;
    entries.push({ path, type: typeChar, content });
  }
  return entries;
}

const ALLOWED_FILES = /^package\/(package\.json|README\.md|CHANGELOG\.md|LICENSE)$/;
const ALLOWED_DIST = /^package\/dist\/[\w./-]+\.(js|d\.ts|js\.map|d\.ts\.map)$/;
const REQUIRED = [
  'package/package.json',
  'package/README.md',
  'package/LICENSE',
  'package/dist/index.js',
  'package/dist/index.d.ts',
];

/** C10: only the build output, README, changelog and license; regular files only. */
export function checkEntries(entries: readonly TarEntry[]): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    if (entry.type === '5') continue;
    if (entry.type !== '0') {
      problems.push(`${entry.path}: not a regular file (type ${entry.type})`);
    } else if (entry.path.includes('..')) {
      problems.push(`${entry.path}: path with ..`);
    } else if (!ALLOWED_FILES.test(entry.path) && !ALLOWED_DIST.test(entry.path)) {
      problems.push(`${entry.path}: not in the allow-list`);
    }
  }
  const paths = new Set(entries.map((e) => e.path));
  for (const path of REQUIRED) {
    if (!paths.has(path)) problems.push(`${path}: missing`);
  }
  return problems;
}

/** L10: lifecycle script names npm or pnpm may run on install, pack or publish. */
export const LIFECYCLE_SCRIPT = /^(pre|post)?(install|prepare|publish|pack|version)$/;
const LIFECYCLE_EXTRA = new Set(['prepublishOnly', 'dependencies', 'preprepare', 'postprepare']);

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** C10: the packed package.json is ready for the public registry. */
export function checkManifest(manifest: Manifest, expectedName: string): string[] {
  const problems: string[] = [];
  if (manifest.name !== expectedName) {
    problems.push(`name is ${String(manifest.name)}, expected ${expectedName}`);
  }
  if ('private' in manifest) problems.push('has a private field');
  if (manifest.license !== 'GPL-3.0-only') problems.push('license is not GPL-3.0-only');
  const repository = manifest.repository as { directory?: unknown } | undefined;
  if (typeof repository?.directory !== 'string' || repository.directory === '') {
    problems.push('repository.directory is not set');
  }
  for (const key of DEPENDENCY_FIELDS) {
    const deps = (manifest[key] ?? {}) as Record<string, unknown>;
    for (const [dep, range] of Object.entries(deps)) {
      if (String(range).startsWith('workspace:')) {
        problems.push(`${key}.${dep} is a workspace: range`);
      }
    }
  }
  // Resolution fields only: the packed `scripts` (build, typecheck, test) may
  // name the condition as a tsc flag, which no consumer ever runs.
  const resolved: Manifest = { ...manifest };
  delete resolved.scripts;
  if (JSON.stringify(resolved).includes(SOURCE_CONDITION)) {
    problems.push(`still names the ${SOURCE_CONDITION} condition`);
  }
  const scripts = (manifest.scripts ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(scripts)) {
    if (LIFECYCLE_SCRIPT.test(name) || LIFECYCLE_EXTRA.has(name)) {
      problems.push(`has the lifecycle script ${name}`);
    }
  }
  return problems;
}

/** C10: every packed manifest has the same version (one fixed group). */
export function checkSameVersion(manifests: readonly Manifest[]): string[] {
  const versions = new Set(manifests.map((m) => String(m.version)));
  return versions.size === 1 ? [] : [`versions differ: ${[...versions].join(', ')}`];
}

// ---------------------------------------------------------------------------
// Child processes

/**
 * pnpm as `node <pnpm.cjs>` when run from a pnpm script (npm_execpath), so no
 * shell is needed for Windows' pnpm.cmd; plain `pnpm` otherwise.
 */
export function pnpmCommand(): { file: string; prefix: string[] } {
  const execPath = process.env['npm_execpath'];
  if (execPath !== undefined && /pnpm(\.c?js)?$/i.test(execPath)) {
    return { file: process.execPath, prefix: [execPath] };
  }
  if (process.platform === 'win32') {
    throw new Error('run this through pnpm (for example `pnpm pack:check`) on Windows');
  }
  return { file: 'pnpm', prefix: [] };
}

/** npm as `node <npm-cli.js>`, found next to the running node binary. */
export function npmCommand(): { file: string; prefix: string[] } {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const cli = candidates.find((path) => existsSync(path));
  if (cli === undefined) throw new Error('npm-cli.js not found next to node');
  return { file: process.execPath, prefix: [cli] };
}

/**
 * Runs a child with an argument array, never a shell. `env` is for tests only
 * (#63 R5): production callers leave it out, so the child inherits the
 * environment unchanged.
 */
export function run(
  command: { file: string; prefix: string[] },
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): string {
  try {
    return execFileSync(command.file, [...command.prefix, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      ...(env === undefined ? {} : { env }),
    });
  } catch (error) {
    // Show what the failed command printed (tsc reports to stdout).
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string') process.stderr.write(stdout);
    throw error;
  }
}

/**
 * The only way the release scripts call `pnpm pack` (#63, ADR 0021, R1).
 * `ignore-pnpmfile` switches off pnpm's pnpmfile loader for the pack child, so
 * no `beforePacking` hook can rewrite the packed package.json, whichever route
 * names the pnpmfile (root `.pnpmfile.cjs`, `pnpmfile` / `global-pnpmfile` in
 * `.npmrc` or `pnpm-workspace.yaml`, config-dependency plugins, env, user rc
 * files). pnpm 10.28.0 rejects `pnpm pack --ignore-pnpmfile` (not a `pack`
 * option) but accepts the generic `--config.` form. It must stay on the
 * command line: the env-var form loses to `pnpm-workspace.yaml`. The
 * integration test in pack-check.test.ts fails if a pnpm upgrade drops it.
 */
export const PACK_ARGS: readonly string[] = ['pack', '--config.ignore-pnpmfile=true'];

/** Packs the package in `pkgDir` into `dest` with `PACK_ARGS`. `env`: tests only (R5). */
export function packOne(pkgDir: string, dest: string, env?: NodeJS.ProcessEnv): void {
  run(pnpmCommand(), [...PACK_ARGS, '--pack-destination', dest], pkgDir, env);
}

const PINNED_PNPM = /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+.+)?$/;

/**
 * #69 (security L1 of #67): the pnpm version the root `packageManager` pins,
 * `pnpm@10.28.0+sha512...` gives `10.28.0`. Fails closed: anything that is
 * not an exact pnpm pin (missing, not a string, another package manager, no
 * version, a range) throws, so the version check is never skipped.
 */
export function pinnedPnpmVersion(packageManager: unknown): string {
  const match = typeof packageManager === 'string' ? PINNED_PNPM.exec(packageManager) : null;
  if (match?.[1] === undefined) {
    throw new Error(
      'root package.json packageManager must pin pnpm (pnpm@<version>[+<hash>]), ' +
        `got ${JSON.stringify(packageManager)} (#69)`,
    );
  }
  return match[1];
}

/**
 * #69: the pnpm that would pack is the pinned one. `actual` is the
 * `pnpm --version` output, compared exactly after `trim()`; empty output is
 * a mismatch.
 */
export function checkPnpmVersion(actual: string, expected: string): string[] {
  const version = actual.trim();
  if (version !== '' && version === expected) return [];
  return [
    `pnpm ${version === '' ? '(no output)' : version} would pack the release, but the repo ` +
      `pins pnpm ${expected} (packageManager in package.json); run through pnpm (for example ` +
      '`pnpm pack:check`) with corepack enabled (#69, ADR 0021)',
  ];
}

/** `pnpm --version` through the same resolver and `run` path as `packOne`. */
function defaultPnpmVersion(): string {
  return run(pnpmCommand(), ['--version'], repoRoot);
}

export interface PackAllOptions {
  /** Tests only (like `env`, #63 R5): returns the `pnpm --version` output. */
  pnpmVersion?: () => string;
}

/**
 * Packs each published package into `dir` with `packOne`; returns the file
 * names. First checks, once, that `pnpm --version` equals the root
 * `packageManager` pin and throws before packing anything otherwise (#69,
 * security L1 of #67): ADR 0021 verified `PACK_ARGS` for that version only.
 */
export function packAll(dir: string, options: PackAllOptions = {}): string[] {
  const expected = pinnedPnpmVersion(readManifest('.')['packageManager']);
  const actual = (options.pnpmVersion ?? defaultPnpmVersion)();
  const problems = checkPnpmVersion(actual, expected);
  if (problems.length > 0) throw new Error(problems.join('; '));
  return PUBLISHED.map((pkg) => {
    const version = String(readManifest(pkg.dir).version);
    packOne(join(repoRoot, pkg.dir), dir);
    const file = tarballName(pkg.name, version);
    if (!existsSync(join(dir, file))) throw new Error(`pnpm pack did not write ${file}`);
    return file;
  });
}
