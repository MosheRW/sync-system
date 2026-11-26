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

describe('no credentials or old names in tracked files', () => {
  // Read every tracked file once for the three checks below. Scanning the whole
  // repo per test is slow under the parallel full run (#78). Tests only filter.
  let tracked: { path: string; text: string }[] = [];
  beforeAll(() => {
    tracked = trackedFiles()
      .filter((path) => existsSync(join(repoRoot, path)))
      .map((path) => ({ path, text: read(path) }));
  }, 60_000);

  it('has no tracked .npmrc with an auth token (L6)', () => {
    const npmrcs = tracked.filter(({ path }) => /(^|\/)\.npmrc$/.test(path));
    for (const { path, text } of npmrcs) {
      expect(text, path).not.toMatch(/_authToken/);
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
    // #81: the registry check is its own anonymous block, after the revocation
    expect(publishBlock).not.toContain('dist.integrity');
    expect(step('5. Revoke the npm token')).toContain('dist.integrity');
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
    // One `git tag -a` for the packages, one in the reader's own R1 (ADR 0023).
    expect(doc.split('git tag -a').length - 1).toBe(2);
    expect(tagStep.split('git tag -a').length - 1).toBe(1);
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

  it('keeps bundles and outputs outside the repo in a fixed per-version folder (L11, #81)', () => {
    const setup = shell.slice(shell.indexOf('unset REF MODE SRC_URL M'));
    for (const line of [
      'unset REF MODE SRC_URL M',
      'export REL="$HOME/sync-release-$V"',
      'export IMG="$REL/image"',
      '[ ! -L "$REL" ] || { echo "$REL is a symlink"; exit 1; }',
      'mkdir -p "$REL" && chmod 700 "$REL"',
    ]) {
      expect(setup, line).toContain(line);
    }
    expect(doc).not.toContain('export IMG="$(mktemp -d)"');
    expect(doc.replace(/\s+/g, ' ')).toContain('not checked out at `$HOME` itself');
    // the dry run must not collide with a real release folder of the same V
    const dryRun = doc.slice(doc.indexOf('## Dry run (QA)'));
    expect(dryRun).toContain('REL="$(mktemp -d)"');
    expect(dryRun).toContain('export IMG="$REL/image"');
    // step 8 removes the folder, guarded
    const after = step('8. After the release');
    expect(after).toContain('[[ "${REL:-}" == "$HOME"/sync-release-[0-9]* ]]');
    expect(after).toContain('rm -rf "$REL"');
  });

  it('keeps the registry DOCKER_CONFIG a mktemp folder, never under $REL (L9, #81)', () => {
    const push = step('6. The server image');
    expect(push).toContain('CFG="$(mktemp -d)"');
    expect(push).toContain('export DOCKER_CONFIG="$CFG"');
    expect(shell).not.toMatch(/DOCKER_CONFIG=[^\n]*\$\{?(REL|IMG|H|D)\b/);
    expect(shell).not.toMatch(/CFG=[^\n]*\$\{?(REL|IMG|H|D)\b/);
  });

  it('re-clones in the check block and re-checks the clone before the push (#81, L2, L3)', () => {
    const push = step('6. The server image');
    const guard =
      '[ -n "${IMG:-}" ] && [ "$IMG" = "${REL:-}/image" ] || { echo \'set REL and IMG (Phase B setup)\'; exit 1; }';
    expect(push.split(guard).length - 1).toBe(2);
    const clone = push.indexOf('git clone');
    expect(push.indexOf('rm -rf "$D/src"')).toBeLessThan(clone);
    const statuses = push.split('status --porcelain --ignored').length - 1;
    expect(statuses).toBe(2);
    expect(push).not.toMatch(/status --porcelain\)/);
    const firstLogin = push.indexOf('docker login');
    const recheck = push.indexOf('run the check block again');
    expect(recheck).toBeGreaterThan(clone);
    expect(recheck).toBeLessThan(firstLogin);
  });

  it('has a resume section that sets M again from the tag (#81, L5)', () => {
    const resume = step('Resume in another terminal');
    expect(resume).toContain('export M="$(git rev-parse "refs/tags/v$V^{commit}")"');
    expect(resume).toContain('[[ "$M" =~ ^[0-9a-f]{40}$ ]]');
    expect(resume).toContain('git merge-base --is-ancestor "$M" origin/main');
    expect(resume).toContain('release notes draft');
    expect(resume).toContain('never run step 1 again');
    expect(resume).toMatch(/new token/);
  });

  it('says the blocks are bash and how to run them from PowerShell (#81 AC1, M4, R7)', () => {
    const before = doc
      .slice(doc.indexOf('## Before you start'), doc.indexOf('## Phase A'))
      .replace(/\s+/g, ' ');
    for (const text of [
      'never PowerShell or cmd',
      "ParserError: Missing closing ')'",
      '& "C:\\Program Files\\Git\\bin\\bash.exe" -l',
      '& "C:\\Program Files\\Git\\bin\\bash.exe" <file>',
      '**outside the repo**',
      'Never write a token into such a file',
      'Delete the file after the release',
      'Paste a token only right after its token prompt is visible',
      '(Get-PSReadLineOption).HistorySavePath',
      'history -d',
      'revoke it now',
    ]) {
      expect(before, text).toContain(text);
    }
  });

  it('verifies the registry anonymously after the revocation, ~5 minutes (#81 AC2, R4, M2, L6)', () => {
    const verify = step('5. Revoke the npm token');
    // revocation comes first, then the verify block
    expect(verify.indexOf('delete `sync-system-release-vX.Y.Z`')).toBeLessThan(
      verify.indexOf('```sh'),
    );
    const code = verify.slice(verify.indexOf('```sh'));
    const runs = code.split(/\r?\n/).filter((line) => /docker (run|exec)\b/.test(line));
    expect(runs).toHaveLength(1);
    const run = runs[0] ?? '';
    expect(run).toContain(
      'docker run --rm "$NODE_IMAGE" npm view "$1@$V" dist.integrity --prefer-online',
    );
    expect(run).not.toMatch(/\s(-e|-i|-it|-v|--env|--env-file|--volume|--mount)\b/);
    expect(code).not.toMatch(/DOCKER_CONFIG|read -r|_authToken|NPM_TOKEN|\btrap\b/);
    expect(code).toContain('$(seq 30)');
    expect(code).toContain('sleep 10');
    expect(code).toContain('E404');
    expect(code).toContain(`awk -v f="$2" '$1 == f { print $2 }' "$H/out/INTEGRITY.txt"`);
    expect(code).toContain('echo "$2 expected $want"');
    expect(code).toContain('(not an incident): run this block again in a few minutes');
    // INCIDENT only on a non-empty, different value, and only once in all shell code
    expect(shell.split('INCIDENT').length - 1).toBe(1);
    const incident = code.indexOf('INCIDENT');
    const nonEmpty = code.indexOf('if [ -n "$got" ]; then');
    expect(nonEmpty).toBeGreaterThan(code.indexOf('if [ "$got" = "$want" ]'));
    expect(incident).toBeGreaterThan(nonEmpty);
    expect(verify.replace(/\s+/g, ' ')).toContain('2-3 minutes');
    // the publish block keeps its cleanup, and only the "already published" view
    expect(publishBlock).toContain('docker exec "$C" rm -f /root/.npmrc');
    expect(publishBlock).toMatch(/npm view "\$1@\$V" version/);
  });

  it('needs a classic GHCR token and checks its prefix before the login (#81 AC3, R2, R3)', () => {
    const push = step('6. The server image');
    const flat = push.replace(/\s+/g, ' ');
    for (const text of [
      '**Tokens (classic)**',
      '**untick `repo`**',
      'only `write:packages` and `read:packages`',
      'fine-grained',
      'The token provided does not match expected scopes',
      'never "No expiration"',
    ]) {
      expect(flat, text).toContain(text);
    }
    const check = push.indexOf('case "$T" in ghp_*)');
    expect(check).toBeGreaterThan(
      push.indexOf("read -rs -p 'GHCR classic token (write:packages): ' T"),
    );
    expect(check).toBeLessThan(push.indexOf('docker login ghcr.io'));
    expect(push.indexOf('trap ')).toBeLessThan(check);
    // $T is only matched by `case` or piped by printf into docker login, never printed
    const usesT = shell.split(/\r?\n/).filter((line) => /\$\{?T\b/.test(line));
    expect(usesT.length).toBeGreaterThanOrEqual(3);
    for (const line of usesT) {
      const piped = /^\s*printf '%s' "\$T" \| docker login \S+ -u \S+ --password-stdin$/.test(line);
      const matched = /^\s*case "\$T" in ghp_\*\) ;; \*\) echo '[^'$]*'; exit 1 ;; esac$/.test(
        line,
      );
      expect(piped || matched, line).toBe(true);
    }
  });

  it('says which PR to release when there is no separate release PR (#81 AC5)', () => {
    const which = step('Which PR');
    expect(which).toContain('gh pr list --state merged --base main');
    expect(which).toContain('mergeCommit');
    expect(which).toMatch(/no separate release PR/);
    expect(which).toContain('newest merged PR on `main`');
  });

  it('treats the shared index.docker.io entry as unprovable and revocation as the control (#81 AC6, R6)', () => {
    const push = step('6. The server image');
    const flat = push.replace(/\s+/g, ' ');
    for (const text of [
      '**Before the push block**',
      'Docker Desktop',
      'https://index.docker.io/v1/',
      'cannot be told apart from a leftover release login',
      'proves no logout',
      '`ghcr.io` must not be listed',
      'Revoking the Docker Hub token (below) is the control, and it is mandatory.',
      'This is mandatory whatever the lists show',
    ]) {
      expect(flat, text).toContain(text);
    }
    expect(push.indexOf('**Before the push block**')).toBeLessThan(push.indexOf('docker login'));
    expect(flat).not.toMatch(/neither may show `ghcr\.io` or `index\.docker\.io`/);
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

describe('RELEASING.md reader image release (#77, ADR 0023, security.md controls 4-9, 11)', () => {
  const doc = read('RELEASING.md');
  const start = doc.indexOf('\n## Reader image release\n');
  const reader = start === -1 ? '' : doc.slice(start, doc.indexOf('\n## ', start + 4));
  const sub = (heading: string): string => {
    const at = reader.indexOf(`\n### ${heading}`);
    expect(at, heading).toBeGreaterThanOrEqual(0);
    const next = reader.slice(at + 5).search(/\n##+ /);
    return next === -1 ? reader.slice(at) : reader.slice(at, at + 5 + next);
  };
  const tagBlock = sub('R1. Tag on the host');
  const checkBlock = sub('R3. Check the image');
  const pushBlock = sub('R4. Push the image');
  // Built at run time so this file doesn't match itself.
  const placeholderMirror = ['docker.io/', 'mosherw/'].join('');

  it('is one section between step 8 and the dry run, linked from the intro', () => {
    expect(start).toBeGreaterThan(doc.indexOf('### 8. After the release'));
    expect(start).toBeLessThan(doc.indexOf('\n## Dry run (QA)'));
    expect(doc.slice(0, doc.indexOf('\n## The rule'))).toContain(
      '[Reader image release](#reader-image-release)',
    );
    expect(reader).toContain('reader-v$RV');
    expect(reader).toMatch(/do not release the reader image until #27 and #28 are closed/i);
  });

  it('tags only after the blockers are fixed in RM, with no date heuristic (L1)', () => {
    expect(tagBlock).toContain('BLOCKERS="27 28"');
    expect(tagBlock).toContain('gh issue view "$n" --json state,stateReason');
    expect(tagBlock).toContain('CLOSED');
    expect(tagBlock).toContain('[ "$S" != \'CLOSED COMPLETED\' ]');
    expect(tagBlock).toContain('closedByPullRequestsReferences');
    expect(tagBlock).toContain('git merge-base --is-ancestor "$MC" "$RM"');
    expect(tagBlock).toMatch(/read -r -p "Type yes[^"]*" OK/);
    expect(tagBlock).not.toMatch(/closedAt|committerdate|%cI|%ct/);
  });

  it('tags a checked commit of origin/main and pushes only that tag (control 4)', () => {
    expect(tagBlock).toContain('[[ "$RV" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]');
    expect(tagBlock).toContain('RM="${RM:-$(git rev-parse origin/main)}"');
    expect(tagBlock).toContain('[[ "$RM" =~ ^[0-9a-f]{40}$ ]]');
    expect(tagBlock).toContain('git merge-base --is-ancestor "$RM" origin/main');
    for (const file of [
      'apps/reader/package.json',
      'apps/reader/src/config/version.ts',
      'apps/reader/CHANGELOG.md',
    ]) {
      expect(tagBlock, file).toContain(`git show "$RM:${file}"`);
    }
    expect(tagBlock).toContain(`grep -q '"private": true'`);
    expect(tagBlock).toContain('git rev-parse -q --verify "refs/tags/reader-v$RV"');
    expect(tagBlock).toContain('git ls-remote --exit-code --tags origin "refs/tags/reader-v$RV"');
    expect(tagBlock).toContain('git tag -a "reader-v$RV" "$RM" -m "reader-v$RV"');
    const pushes = reader.split(/\r?\n/).filter((line) => /\bgit push\b/.test(line));
    expect(pushes).toEqual(['  git push origin "refs/tags/reader-v$RV"']);
  });

  it('checks the image from a fresh clone and marks it checked only at the end (control 5, M1)', () => {
    expect(checkBlock).toContain('git clone --quiet --branch "$REF" --depth 1 "$SRC_URL" "$D/src"');
    expect(checkBlock).toContain('[ "$(git -C "$D/src" rev-parse HEAD)" = "$RM" ]');
    expect(checkBlock).toContain('[ -z "$(git -C "$D/src" status --porcelain)" ]');
    expect(checkBlock).toContain('rm -rf "$D/src" "$D/checked"');
    expect(checkBlock).toContain('/health');
    expect(checkBlock).toContain('\\"version\\":\\"$RV\\"');
    expect(checkBlock).toContain('id -u');
    expect(checkBlock).toContain("-name '*.map'");
    expect(checkBlock).toContain('org.opencontainers.image.revision=$RM');
    expect(checkBlock).toContain('--platform linux/arm64');
    // The check container gets no env, no mount and no credential.
    const run = checkBlock.split(/\r?\n/).find((line) => /docker run\b/.test(line)) ?? '';
    expect(run).toBe(
      '  docker run -d --name sync-reader-health "sync-reader-check:$RV" >/dev/null',
    );
    const code = checkBlock.slice(checkBlock.indexOf('```sh'), checkBlock.lastIndexOf('```'));
    const lines = code.split(/\r?\n/).filter((line) => line.trim() !== '' && line !== ')');
    expect(lines.at(-2)).toBe('  echo "$RM" > "$D/checked"');
  });

  it('pushes only a checked clone, with the step 6 credential pattern (control 6, M1, C3)', () => {
    const code = pushBlock.slice(pushBlock.indexOf('```sh'));
    const guard = code.indexOf('[ "$(tail -n 1 "$D/checked")" = "$RM" ]');
    const head = code.indexOf('[ "$(git -C "$D/src" rev-parse HEAD)" = "$RM" ]');
    const clean = code.indexOf('[ -z "$(git -C "$D/src" status --porcelain)" ]');
    const login = code.indexOf('docker login');
    for (const at of [guard, head, clean]) {
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(login);
    }
    expect(code).toContain('export DOCKER_CONFIG="$CFG"');
    const trap = /trap '([^']*docker logout[^']*)' EXIT/.exec(code)?.[1] ?? '';
    expect(trap).toMatch(/docker logout ghcr\.io[^;]*\|\| true/);
    expect(trap).toMatch(/docker logout docker\.io[^;]*\|\| true/);
    expect(trap).toContain('rm -rf "$DOCKER_CONFIG"');
    expect(code.indexOf("trap 'docker logout ghcr.io")).toBeLessThan(login);
    expect(code).toContain('read -rs -p');
    expect(code).toContain(`printf '%s' "$T" | docker login ghcr.io -u mosherw --password-stdin`);
    expect(code).toContain(
      `printf '%s' "$T" | docker login docker.io -u moshewin --password-stdin`,
    );
    expect(code.split('unset T').length - 1).toBe(2);
    expect(code).toContain('--platform linux/amd64,linux/arm64 --push');
    for (const tag of ['$RV', '$MAJOR.$MINOR', '$MAJOR', 'latest']) {
      expect(code, tag).toContain(`ghcr.io/mosherw/sync-system-reader:${tag}`);
      expect(code, tag).toContain(`docker.io/moshewin/sync-system-reader:${tag}`);
    }
    expect(code).toContain('imagetools inspect "ghcr.io/mosherw/sync-system-reader:$RV"');
    expect(code).toContain('imagetools inspect "docker.io/moshewin/sync-system-reader:$RV"');
    expect(pushBlock).toMatch(/revoke\s+both registry tokens/i);
    expect(pushBlock).toContain('(#6-the-server-image-on-the-host)');
  });

  it('creates the GHCR token with write:packages only and checks its scopes (control 7, M2)', () => {
    expect(pushBlock).toContain('https://github.com/settings/tokens/new?scopes=write:packages');
    expect(pushBlock).toMatch(/if `repo` is ticked,\s+untick it/);
    expect(pushBlock).toContain('"Read & Write"');
  });

  it('creates the GitHub release from the existing tag, never as Latest (control 8, L2)', () => {
    expect(sub('R5. GitHub release')).toContain(
      'gh release create "reader-v$RV" --verify-tag --latest=false',
    );
  });

  it('checks anonymous pulls in a cleaned-up temporary config (control 9, L4)', () => {
    const after = sub('R6. After the reader release');
    expect(after).toContain('set the GHCR package `sync-system-reader` public');
    const code = after.slice(after.indexOf('```sh'));
    expect(code).toMatch(/^\( set -euo pipefail$/m);
    expect(code).toContain('export MSYS_NO_PATHCONV=1');
    expect(code).toContain('CFG="$(cygpath -m "$CFG")"');
    expect(code).toContain(`trap 'rm -rf "$DOCKER_CONFIG"' EXIT`);
    expect(code).toContain('docker pull');
    expect(code).not.toContain('docker login');
  });

  it('has a reader dry run that never tags, logs in or pushes', () => {
    const dry = sub('Reader dry run (QA)');
    expect(dry).toContain('cygpath -m "$(pwd)"');
    expect(dry).toMatch(/Never run R1, R4 or R5/);
    expect(dry).not.toMatch(/docker login|git tag|--push/);
  });

  it('never pushes to the placeholder namespace and keeps the npm bans', () => {
    expect(reader).not.toContain(placeholderMirror);
    for (const banned of ['docker login -p', 'set -x', 'echo $T', 'echo "$T"', 'npm publish']) {
      expect(reader, banned).not.toContain(banned);
    }
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

  it('keeps the reader private at its own 1.0.0, outside the group (ADR 0023 B1)', () => {
    expect(manifest('apps/reader').version).toBe('1.0.0');
    expect(manifest('apps/reader').private).toBe(true);
    expect(read('apps/reader/src/config/version.ts')).toMatch(
      /^export const READER_VERSION = '1\.0\.0';$/m,
    );
    const changelog = read('apps/reader/CHANGELOG.md');
    expect(changelog).toMatch(/^# @mosherw\/sync-system-reader$/m);
    expect(changelog).toMatch(/^## 1\.0\.0$/m);
    const config = JSON.parse(read('.changeset/config.json')) as {
      fixed: string[][];
      ignore: string[];
    };
    expect(config.ignore).toEqual(['@mosherw/sync-system-reader']);
    expect(config.fixed.flat()).not.toContain('@mosherw/sync-system-reader');
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
