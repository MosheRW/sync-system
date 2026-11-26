// Release files (#37): license, package metadata, the publishable set and the
// release procedure's load-bearing lines. Reads the repo, starts nothing.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

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

// npm credential keys in an .npmrc, bare or scoped (`//host/:key=`):
// `_authToken` anywhere (as before), plus the legacy `_auth` and `_password`
// keys only as a whole key followed by `=`, so `_auth` is matched on its own
// and not just through `_authToken`.
const NPMRC_CREDENTIAL = /_authToken|(?:^|[\s:])(?:_auth|_password)\s*=/m;

describe('no credentials or old names in tracked files', () => {
  // Read every tracked file once for the three checks below. Scanning the whole
  // repo per test is slow under the parallel full run (#78). Tests only filter.
  let tracked: { path: string; text: string }[] = [];
  // Tracked .npmrc files deleted from disk: the filter below would skip them silently.
  let missingNpmrcs: string[] = [];
  beforeAll(() => {
    const paths = trackedFiles();
    missingNpmrcs = paths.filter(
      (path) => /(^|\/)\.npmrc$/.test(path) && !existsSync(join(repoRoot, path)),
    );
    tracked = paths
      .filter((path) => existsSync(join(repoRoot, path)))
      .map((path) => ({ path, text: read(path) }));
  }, 60_000);

  it('has no tracked .npmrc with a credential (L6)', () => {
    expect(
      missingNpmrcs,
      `tracked .npmrc missing on disk, cannot check it for credentials: ${missingNpmrcs.join(', ')}`,
    ).toEqual([]);
    const npmrcs = tracked.filter(({ path }) => /(^|\/)\.npmrc$/.test(path));
    for (const { path, text } of npmrcs) {
      expect(text, `${path} contains an npm credential key`).not.toMatch(NPMRC_CREDENTIAL);
    }
  });

  it('has no old placeholder scope left outside history (AC50, Q-C)', () => {
    const oldScope = ['@sync', '-system/'].join('');
    const history = /^(docs\/issues\/|docs\/decisions\/00(0\d|1[0-5])-)/;
    const hits = tracked
      .filter(({ path }) => !history.test(path) && !path.endsWith('.zip'))
      .filter(({ text }) => text.includes(oldScope))
      .map(({ path }) => path);
    expect(hits).toEqual([]);
  });

  it('names the Docker Hub mirror under moshewin, never the mosherw namespace (#65)', () => {
    // Built at run time so this file doesn't match itself.
    const oldMirror = ['docker.io/', 'mosherw'].join('');
    // The mosherw name is right only after `ghcr.io/` or as the npm `@` scope.
    const bareOld = /(?<!ghcr\.io\/|@)mosherw\/sync-system-server/;
    const hits = tracked
      .filter(({ path }) => !path.startsWith('docs/issues/') && !path.endsWith('.zip'))
      .filter(({ text }) => text.includes(oldMirror) || bareOld.test(text))
      .map(({ path }) => path);
    expect(hits).toEqual([]);
  });
});

/** The one non-test fingerprint ADR 0022 allows: the public JWT header constant. */
const JWT_HEADER_ENTRY =
  '09c7cacfc5432e2293a101649d0e40e009aa52f6:apps/sync-server/src/tokens/jwt.ts:generic-api-key:10';

/** Why a `.gitleaksignore` entry is outside ADR 0022's scope, or null if it is inside. */
function gitleaksIgnoreViolation(entry: string): string | null {
  const match = /^[0-9a-f]{40}:([^:]+):([a-z0-9-]+):\d+$/.exec(entry);
  if (!match) return 'not <commit>:<file>:<rule>:<line>';
  const [, path = '', rule = ''] = match;
  if (rule !== 'generic-api-key') return `rule ${rule} is not generic-api-key`;
  if (!/(^|\/)test\//.test(path) && entry !== JWT_HEADER_ENTRY) return 'file is not under test/';
  return null;
}

describe('.gitleaksignore scope (ADR 0022, security M1)', () => {
  const entries = read('.gitleaksignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  it('has entries, each a test-file or jwt.ts header generic-api-key fingerprint', () => {
    expect(entries.length).toBeGreaterThan(0);
    const outside = entries
      .map((entry) => [entry, gitleaksIgnoreViolation(entry)] as const)
      .filter(([, why]) => why !== null);
    expect(outside).toEqual([]);
    expect(entries).toContain(JWT_HEADER_ENTRY);
  });

  it('rejects entries outside the scope', () => {
    const sha = 'a'.repeat(40);
    for (const entry of [
      `${sha}:apps/sync-server/src/config/env.ts:generic-api-key:3`,
      `${sha}:apps/sync-server/test/main.test.ts:private-key:3`,
      `${sha}:apps/sync-server/test/main.test.ts:npm-access-token:3`,
      `${sha}:apps/sync-server/src/tokens/jwt.ts:generic-api-key:10`,
      '09c7cacfc5432e2293a101649d0e40e009aa52f6:apps/sync-server/src/tokens/jwt.ts:generic-api-key:11',
      `${sha}:apps/sync-server/latest/x.ts:generic-api-key:3`,
      `${sha.slice(1)}:apps/sync-server/test/main.test.ts:generic-api-key:3`,
      `${sha}:apps/sync-server/test/main.test.ts:generic-api-key`,
    ]) {
      expect(gitleaksIgnoreViolation(entry), entry).not.toBeNull();
    }
    expect(
      gitleaksIgnoreViolation(`${sha}:packages/client/test/x.test.ts:generic-api-key:1`),
    ).toBeNull();
  });
});

describe('changesets (ADR 0016, AC49, C9)', () => {
  interface ChangesetConfig {
    fixed: string[][];
    ignore: string[];
    privatePackages: { version: boolean; tag: boolean };
    changelog: string;
    access: string;
    commit: boolean;
  }
  const config = JSON.parse(read('.changeset/config.json')) as ChangesetConfig;

  it('keeps protocol, client, react and server in one fixed group, reader ignored', () => {
    expect(config.fixed).toEqual([[...PUBLISHED_NAMES, '@mosherw/sync-system-server']]);
    expect(config.ignore).toEqual(['@mosherw/sync-system-reader']);
    expect(config.privatePackages).toEqual({ version: true, tag: false });
  });

  it('uses the built-in changelog generator, public access and no auto-commit', () => {
    expect(config.changelog).toBe('@changesets/cli/changelog');
    expect(config.access).toBe('public');
    expect(config.commit).toBe(false);
    expect(read('package.json')).not.toContain('@changesets/changelog-github');
  });

  it('pins @changesets/cli exactly and never lets it run build scripts (C9, L2)', () => {
    const root = manifest('.') as Manifest & {
      devDependencies: Record<string, string>;
      pnpm?: { onlyBuiltDependencies?: string[] };
    };
    expect(root.devDependencies['@changesets/cli']).toMatch(/^\d+\.\d+\.\d+$/);
    const built = root.pnpm?.onlyBuiltDependencies ?? [];
    expect(built.filter((name) => name.startsWith('@changesets/'))).toEqual([]);
  });

  it('pins pnpm with a sha512 so corepack verifies it (L1)', () => {
    expect(manifest('.').packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/);
  });
});

describe('RELEASING.md load-bearing lines (C1-C5, M6, L1, L5, L8, L9, L11-L13)', () => {
  const doc = read('RELEASING.md');
  /** The shell code blocks only (what the maintainer pastes). */
  const shell = [...doc.matchAll(/```sh\r?\n([\s\S]*?)```/g)].map((m) => m[1] ?? '').join('\n');
  const step = (heading: string): string => {
    const start = doc.indexOf(`### ${heading}`);
    expect(start, heading).toBeGreaterThanOrEqual(0);
    const next = doc.slice(start + 4).search(/\n##+ /);
    return next === -1 ? doc.slice(start) : doc.slice(start, start + 4 + next);
  };
  const publishBlock = step('4. Publish container');

  it('never logs in to npm interactively, never uses an OTP and never publishes from the workspace', () => {
    for (const banned of ['--otp', 'npm login', 'pnpm -r publish', 'changeset publish']) {
      expect(doc, banned).not.toContain(banned);
    }
  });

  it('publishes tarballs by path with --access public and --ignore-scripts', () => {
    const publishes = shell.split(/\r?\n/).filter((line) => /\bnpm publish\b/.test(line));
    expect(publishes.length).toBeGreaterThan(0);
    for (const line of publishes) {
      expect(line).toContain('--access public');
      expect(line).toContain('--ignore-scripts');
    }
    for (const pkg of ['protocol', 'client', 'react']) {
      expect(publishBlock).toContain(`mosherw-sync-system-${pkg}-$V.tgz`);
    }
  });

  it('checks the tarballs before the token exists (L8) and the registry after', () => {
    expect(publishBlock).toContain('find /release -mindepth 1 ! -type f');
    expect(publishBlock).toContain('tar -xOzf');
    expect(publishBlock).toContain('sha512-');
    expect(publishBlock).toContain('dist.integrity');
    const tokenRead = publishBlock.indexOf('read -rs');
    for (const check of ['find /release', 'tar -xOzf', 'diff "$H/recomputed.txt"']) {
      expect(publishBlock.indexOf(check), check).toBeLessThan(tokenRead);
    }
  });

  it('pins both containers by digest (L1)', () => {
    expect(shell).toMatch(/node:24@sha256:[0-9a-f]{64}/);
    for (const match of shell.matchAll(/node:24(\S*)/g)) {
      expect(match[1], match[0]).toMatch(/^@sha256:[0-9a-f]{64}/);
    }
  });

  it('hands the npm token over stdin into a mode-600 file only (C1 as amended for E2)', () => {
    expect(publishBlock).toMatch(/read -rs -p '[^']*' NPM_TOKEN/);
    expect(publishBlock).toContain(
      `printf '//registry.npmjs.org/:_authToken=%s\\n' "$NPM_TOKEN" | docker exec -i "$C" sh -c 'umask 077 && cat > /root/.npmrc'`,
    );
    expect(publishBlock).toContain('unset NPM_TOKEN');
    expect(publishBlock).toContain('npm whoami');
    for (const token of doc.matchAll(/_authToken=(\S*)/g)) {
      expect(token[1], token[0]).toMatch(/^%s/);
    }
    for (const banned of ['-e NPM_TOKEN', '--env-file', 'export NPM_TOKEN', 'set -x']) {
      expect(doc, banned).not.toContain(banned);
    }
    expect(doc).not.toMatch(/\bNPM_TOKEN=/);
    expect(doc).not.toMatch(/echo[^\n]*\$\{?NPM_TOKEN/);
  });

  it('checks the pasted token and attaches no stdin before reading it (L12)', () => {
    expect(publishBlock).toContain('[ -n "${NPM_TOKEN:-}" ]');
    expect(publishBlock).toContain('case "$NPM_TOKEN" in npm_*)');
    const code = publishBlock.slice(publishBlock.indexOf('```sh'));
    const beforeRead = code.slice(0, code.indexOf('read -rs'));
    expect(beforeRead).not.toMatch(/docker (exec|run)[^\n]* -(i|it)\b/);
    expect(publishBlock).toMatch(/[Pp]aste only the first block below/);
  });

  it('removes the publish container on every exit path, failure-tolerant (M6)', () => {
    const trap = /trap '([^']*)' EXIT/.exec(publishBlock)?.[1] ?? '';
    expect(trap).toContain('unset NPM_TOKEN');
    expect(trap).toMatch(/docker exec "\$C" npm logout[^;]*\|\| true/);
    expect(trap).toMatch(/docker rm -f "\$C"[^;]*\|\| true/);
    expect(publishBlock.indexOf('trap ')).toBeLessThan(publishBlock.indexOf('docker run'));
    expect(publishBlock).toContain('docker ps -a --filter name=sync-release-publish');
  });

  it('makes every cleanup trap failure-tolerant (M6)', () => {
    const traps = [...shell.matchAll(/trap '([^']*)' EXIT/g)].map((m) => m[1] ?? '');
    expect(traps.length).toBeGreaterThanOrEqual(4);
    for (const trap of traps) {
      for (const command of trap.split(';').map((c) => c.trim())) {
        if (command.startsWith('docker ')) expect(command, trap).toMatch(/\|\| true$/);
      }
    }
  });

  it('logs out of both registries and removes the config on every exit (C3, L9)', () => {
    const push = step('6. The server image');
    const trap = /trap '([^']*docker logout[^']*)' EXIT/.exec(push)?.[1] ?? '';
    expect(trap).toMatch(/docker logout ghcr\.io[^;]*\|\| true/);
    expect(trap).toMatch(/docker logout docker\.io[^;]*\|\| true/);
    expect(trap).toContain('rm -rf "$DOCKER_CONFIG"');
    expect(push.indexOf(trap)).toBeLessThan(push.indexOf('docker login'));
    expect(push).toContain('--password-stdin');
    expect(push).toContain('docker-credential-');
    expect(push).toMatch(/revoke both registry tokens/i);
  });

  it('pushes the mirror to docker.io/moshewin and GHCR to ghcr.io/mosherw (#65)', () => {
    const push = step('6. The server image');
    expect(push).toContain(`docker login ghcr.io -u mosherw --password-stdin`);
    expect(push).toContain(`docker login docker.io -u moshewin --password-stdin`);
    for (const tag of ['$V', '$MAJOR.$MINOR', '$MAJOR', 'latest']) {
      expect(push, tag).toContain(`ghcr.io/mosherw/sync-system-server:${tag}`);
      expect(push, tag).toContain(`docker.io/moshewin/sync-system-server:${tag}`);
    }
    expect(push).toContain('imagetools inspect "docker.io/moshewin/sync-system-server:$V"');
    expect(step('0. First release only')).toContain('`moshewin` is your Docker Hub **username**');
  });

  it('checks the real npm user, and org ownership only in step 0 (#65)', () => {
    expect(publishBlock).toContain(
      `[ "$(docker exec "$C" npm whoami)" = moshe-winberg ] || { echo 'npm whoami is not moshe-winberg'; exit 1; }`,
    );
    expect(publishBlock).not.toContain('npm org');
    const first = step('0. First release only');
    expect(first).toContain('`npm org ls mosherw`');
    expect(first).toContain('`npm logout`');
    expect(doc).toContain('Organizations: no access');
  });

  it('runs a pinned, offline, read-only gitleaks scan in step 0 (#65, ADR 0022, L1)', () => {
    expect(doc).toMatch(/^GITLEAKS_IMAGE='zricethezav\/gitleaks:v8\.24\.0@sha256:[0-9a-f]{64}'$/m);
    for (const match of doc.matchAll(/zricethezav\/gitleaks:([^\s'`]*)/g)) {
      // skip the bump instructions' placeholder and the block's own format check
      if (match[1] === '<tag>' || match[1]?.startsWith('v[0-9.]+@')) continue;
      expect(match[1], match[0]).toMatch(/^v[0-9.]+@sha256:[0-9a-f]{64}$/);
    }
    const first = step('0. First release only');
    const scans = first.split(/\r?\n/).filter((line) => line.includes('"$GITLEAKS_IMAGE"'));
    expect(scans).toHaveLength(1);
    const scan = scans[0] ?? '';
    expect(scan).toMatch(/docker run --rm /);
    expect(scan).toContain('--network none');
    expect(scan).toContain(':/repo:ro"');
    expect(scan).toMatch(/ git \/repo --redact$/);
    expect(scan).not.toMatch(/\s(-e|--env|--env-file)\b/);
    expect(first).toContain('.gitleaksignore');
  });

  it('tags only on the host, from the verified merge commit (C2)', () => {
    const tagStep = step('1. Tag on the host');
    expect(tagStep).toContain('git tag -a');
    expect(doc.split('git tag -a').length - 1).toBe(1);
    expect(tagStep).toContain('git merge-base --is-ancestor');
    expect(tagStep).toContain('mergeCommit');
    const build = step('2. Build container');
    expect(build).toContain('git bundle create');
    expect(build).toContain('test "$(git rev-parse HEAD)" = "$SHA"');
    expect(build).toContain('test -z "$(git status --porcelain)"');
  });

  it('converts the local clone path with cygpath -m in the dry run (AC54, Git Bash)', () => {
    const start = doc.indexOf('## Dry run (QA)');
    expect(start).toBeGreaterThanOrEqual(0);
    const dryRun = doc.slice(start, doc.indexOf('\n## ', start + 3));
    const srcUrl = /SRC_URL="file:\/\/([^`]*)"/.exec(dryRun)?.[1] ?? '';
    expect(srcUrl).toContain('cygpath -m "$(pwd)"');
    expect(srcUrl).toContain('command -v cygpath');
    expect(doc).not.toMatch(/file:\/\/\$\(pwd\)/);
  });

  it('keeps bundles and outputs outside the repo (L11)', () => {
    expect(doc).toContain('export REL="$(mktemp -d)"');
    expect(doc).toContain('export IMG="$(mktemp -d)"');
  });

  it('has the first-release ownership checklist and the npm settings (C5, E2)', () => {
    expect(doc).toMatch(/^### 0\. First release only: ownership checklist/m);
    expect(doc.replace(/\s+/g, ' ')).toContain('Bypass two-factor authentication');
    expect(doc.replace(/\s+/g, ' ')).toContain(
      'Require two-factor authentication or a granular access token',
    );
    expect(doc).toContain('npm access list packages @mosherw');
  });

  it('revokes the npm token right after the publish, with the lifecycle rules (L13)', () => {
    expect(doc).toMatch(/### 5\. Revoke the npm token/);
    expect(doc).toContain('1 day');
    expect(doc).toMatch(/clipboard/i);
    expect(doc).toContain('step 3 with a new token');
  });

  it('puts the integrity values and the image digest in the release notes (L5)', () => {
    const notes = step('7. GitHub release notes');
    expect(notes).toContain('sha512-');
    expect(notes).toContain('sha256:');
  });

  it('states the residual risk and the known limits', () => {
    expect(doc).toMatch(/^## Residual risk$/m);
    expect(doc).toMatch(/^## Known limits$/m);
    expect(doc).toContain('provenance');
  });

  it('states that packing ignores every pnpmfile and the residual (#63, ADR 0021, R6)', () => {
    const flat = (text: string): string => text.replace(/\s+/g, ' ');
    const limits = flat(doc.slice(doc.indexOf('## Known limits')));
    for (const text of [
      '--config.ignore-pnpmfile=true',
      'pnpm-workspace.yaml',
      'configDependencies',
      'outer',
      'release-relevant',
      '(docs/decisions/0021-pack-with-pnpmfiles-ignored.md)',
      // security A1: the early fail through `pnpm run`'s exported setting
      'exports it to the script as `npm_config_pnpmfile`',
      'fails closed',
    ]) {
      expect(limits, text).toContain(text);
    }
  });

  it('states the tarball reproducibility scope and the after-bump checks (#53, ADR 0020)', () => {
    const flat = (text: string): string => text.replace(/\s+/g, ' ');
    const limits = flat(doc.slice(doc.indexOf('## Known limits')));
    for (const text of [
      'linux/amd64',
      'workspace:',
      'pnpmfile',
      'gzip',
      'host OS',
      'zlib',
      'step 4',
      '(docs/decisions/0020-deterministic-packed-manifests.md)',
    ]) {
      expect(limits, text).toContain(text);
    }
    expect(limits).not.toContain('0019');
    const before = flat(doc.slice(doc.indexOf('## Before you start'), doc.indexOf('## Phase A')));
    for (const text of [
      // R4 (provenance of a new digest)
      'own PR',
      'second person',
      'docker buildx imagetools inspect docker.io/library/node:24',
      'attestation-manifest',
      'Provenance',
      'node --version',
      'https://nodejs.org/dist/index.json',
      'linux/amd64',
      // R5 (two dry runs, compared by machine)
      '[dry run](#dry-run-qa)',
      'twice',
      'cp "$REL/out/INTEGRITY.txt" "$REL/integrity-run1.txt"',
      'diff "$REL/integrity-run1.txt" "$REL/out/INTEGRITY.txt"',
      'identical',
      'baseline',
    ]) {
      expect(before, text).toContain(text);
    }
    expect(before).not.toContain('expect new integrity values');
  });
});

describe('release candidate 1.0.0 (AC48, AC49)', () => {
  const GROUP_DIRS = [...PUBLISHED_DIRS, 'apps/sync-server'] as const;

  it.each(GROUP_DIRS)('%s is at 1.0.0 with a 1.0.0 changelog entry', (dir) => {
    expect(manifest(dir).version).toBe('1.0.0');
    const changelog = read(join(dir, 'CHANGELOG.md'));
    expect(changelog).toMatch(new RegExp(`^# ${manifest(dir).name}$`, 'm'));
    expect(changelog).toMatch(/^## 1\.0\.0$/m);
  });

  it('keeps the reader private at 0.1.0, outside the group', () => {
    expect(manifest('apps/reader').version).toBe('0.1.0');
    expect(manifest('apps/reader').private).toBe(true);
    expect(existsSync(join(repoRoot, 'apps/reader/CHANGELOG.md'))).toBe(false);
  });

  it('states protocol 1 with minimum 1 and the notes for pre-release builds', () => {
    const entry = read('apps/sync-server/CHANGELOG.md').replace(/\s+/g, ' ');
    for (const text of [
      '`PROTOCOL_VERSION = 1`',
      '`MIN_CLIENT_PROTOCOL_VERSION = 1`',
      'Join by group ID removed (#10)',
      'Token format 2 (#13)',
      '`MAX_BUFFERED_BYTES` minimum',
      'Storage can now be Redis',
      'stopping every instance',
      'Unknown look-alike env variables stop startup (#36)',
      'GPL-3.0-only',
    ]) {
      expect(entry, text).toContain(text);
    }
    for (const dir of PUBLISHED_DIRS) {
      expect(read(join(dir, 'CHANGELOG.md')).replace(/\s+/g, ' ')).toContain(
        'Join by group ID removed (#10)',
      );
    }
  });

  it('has consumed the first changeset', () => {
    expect(existsSync(join(repoRoot, '.changeset/v1-first-release.md'))).toBe(false);
  });
});
