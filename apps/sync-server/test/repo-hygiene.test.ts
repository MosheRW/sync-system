import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEV_REDIS_PASSWORD } from '../src/config/redis.js';
import { DEV_TOKEN_SECRET } from '../src/config/token-secret.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

/** True if git ignores `path` (exit 0 from git check-ignore). */
function isIgnored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('secrets stay out of git and the image (M1)', () => {
  it('ignores real registries and env files but not the committed examples', () => {
    for (const path of ['config/apps.json', 'config/prod.json', '.env', '.env.local']) {
      expect(isIgnored(path), path).toBe(true);
    }
    for (const path of ['config/apps.dev.json', 'config/apps.example.json']) {
      expect(isIgnored(path), path).toBe(false);
    }
  });

  it('keeps config, env files, logs and VCS data out of the Docker build context', () => {
    const lines = read('.dockerignore').split(/\r?\n/);
    for (const entry of ['config/', '.env*', '**/*.log', '.git', 'docs', 'coverage']) {
      expect(lines, entry).toContain(entry);
    }
  });

  it('also keeps nested env files and app registries out of the build context (S3)', () => {
    const lines = read('.dockerignore').split(/\r?\n/);
    // A bare pattern matches only at the context root; these match at any depth.
    expect(lines).toContain('**/.env*');
    expect(lines).toContain('**/config/apps*.json');
    // The server source has a src/config directory, so no pattern may drop
    // every directory named config.
    for (const entry of ['**/config', '**/config/', '**/config/**']) {
      expect(lines, entry).not.toContain(entry);
    }
  });

  it('never copies the repo root into the image', () => {
    const dockerfile = read('apps/sync-server/Dockerfile');
    const copies = dockerfile.split(/\r?\n/).filter((line) => /^COPY\s/.test(line));
    expect(copies.length).toBeGreaterThan(0);
    for (const line of copies) {
      expect(line, line).not.toMatch(/^COPY\s+(--\S+\s+)*\.\s/);
      expect(line, line).not.toMatch(/(^|\s)config\//);
      expect(line, line).not.toContain('.env');
    }
  });
});

describe('pinned supply chain (L8)', () => {
  it('pins every Dockerfile base image by digest', () => {
    const froms = read('apps/sync-server/Dockerfile')
      .split(/\r?\n/)
      .filter((line) => /^FROM\s/.test(line));
    const external = froms.filter((line) => !/^FROM\s+(base|build)\b/.test(line));
    expect(external.length).toBeGreaterThan(0);
    for (const line of external) {
      expect(line, line).toMatch(/@sha256:[0-9a-f]{64}\b/);
    }
  });

  it('runs as the unprivileged node user', () => {
    expect(read('apps/sync-server/Dockerfile')).toMatch(/^USER node$/m);
  });

  it('binds compose to loopback and sets NODE_ENV=development for the dev key (M3, M6)', () => {
    const compose = read('compose.yaml');
    expect(compose).toContain("'127.0.0.1:8080:8080'");
    expect(compose).toMatch(/NODE_ENV: development/);
    expect(compose).toContain('/health');
  });

  it('sets the documented dev token secret in compose (#5 AC3)', () => {
    const compose = read('compose.yaml');
    const match = /^\s*TOKEN_SECRET:\s*(\S+)\s*$/m.exec(compose);
    expect(match?.[1]).toBe(DEV_TOKEN_SECRET);
    expect(compose).not.toMatch(/TOKEN_SECRET_PREVIOUS/);
  });
});

describe('optional Redis compose override (#35 AC30, security C2, C3, C5)', () => {
  const override = read('compose.redis.yaml');
  const redis = override.slice(override.indexOf('  redis:'), override.indexOf('  sync-server:'));

  it('leaves the default compose file on the memory store', () => {
    const compose = read('compose.yaml');
    expect(compose).not.toMatch(/^\s+redis:/m);
    expect(compose).not.toContain('REDIS_URL');
  });

  it('pins the Redis image by digest and publishes no host port', () => {
    expect(redis).toMatch(/image: redis:7\.2\.\d+-alpine@sha256:[0-9a-f]{64}$/m);
    expect(redis).not.toMatch(/^\s+ports:/m);
  });

  it('requires a password, keeps nothing on disk and never evicts', () => {
    const lines = redis.split(/\r?\n/).map((line) => line.trim());
    const flag = (name: string) => lines[lines.indexOf(`- ${name}`) + 1];
    expect(flag('--requirepass')).toBe(`- ${DEV_REDIS_PASSWORD}`);
    expect(flag('--save')).toBe("- ''");
    expect(flag('--appendonly')).toBe("- 'no'");
    expect(flag('--maxmemory-policy')).toBe('- noeviction');
    expect(redis).not.toMatch(/^\s+volumes:/m);
    expect(redis).toMatch(/tmpfs:\s*\n\s+- \/data/);
  });

  it('gives the sync server the dev password, which only development accepts (C5)', () => {
    const url = /REDIS_URL:\s*(\S+)/.exec(override)?.[1];
    expect(url).toBe(`redis://:${DEV_REDIS_PASSWORD}@redis:6379`);
    expect(read('compose.yaml')).toMatch(/NODE_ENV: development/);
  });

  it('pins @redis/client exactly (#35 AC28, ADR 0010)', () => {
    const pkg = JSON.parse(read('apps/sync-server/package.json')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@redis/client']).toBe('6.3.1');
  });
});

describe('CI workflow (AC28, L1, L8)', () => {
  const workflow = read('.github/workflows/ci.yml');

  it('pins every action to a 40-char commit SHA', () => {
    const uses = workflow.split(/\r?\n/).filter((line) => /^\s*-?\s*uses:/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line, line).toMatch(/@[0-9a-f]{40}\s+#\s*v\d/);
    }
  });

  it('runs on push and pull_request with a read-only token and no secrets', () => {
    expect(workflow).toMatch(/^on:\n {2}push:\n {2}pull_request:/m);
    expect(workflow).not.toContain('pull_request_target');
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(workflow).not.toContain('secrets.');
  });

  it('runs the Redis suites against a pinned, loopback, password-only Redis (#35 AC31, F15)', () => {
    const start = workflow.slice(
      workflow.indexOf('name: Start Redis'),
      workflow.indexOf('name: Audit'),
    );
    expect(start).toMatch(/redis:7\.2\.\d+-alpine@sha256:[0-9a-f]{64}/);
    expect(start).toContain('-p 127.0.0.1:6379:6379');
    expect(start).toContain('--requirepass ci-only-redis-password');
    expect(start).toContain('--save "" --appendonly no');
    const test = workflow.slice(
      workflow.indexOf('run: pnpm test'),
      workflow.indexOf('name: Build'),
    );
    expect(test).toContain('SYNC_TEST_REDIS_URL: redis://:ci-only-redis-password@127.0.0.1:6379');
    expect(test).toMatch(/CI: 'true'/);
    expect(workflow.indexOf('name: Start Redis')).toBeLessThan(workflow.indexOf('run: pnpm test'));
  });

  it('installs from the lockfile, audits, then runs every check', () => {
    const steps = [
      'pnpm install --frozen-lockfile',
      'pnpm audit --audit-level=high',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build',
    ];
    let last = -1;
    for (const step of steps) {
      const index = workflow.indexOf(`run: ${step}`);
      expect(index, step).toBeGreaterThan(last);
      last = index;
    }
  });
});

describe('README documents the lifecycle (#13 AC4, AC38, RC14)', () => {
  it('has one timers table with every timer, default and env ceiling', () => {
    const readme = read('README.md');
    const table = readme.slice(readme.indexOf('### Timers'), readme.indexOf('### Roles and'));
    for (const text of [
      'disconnectGraceSeconds',
      'inactivityLimitMinutes',
      'keepAliveCountdownSeconds',
      'maxSessionMinutes',
      'defaultHandoff',
      'DISCONNECT_GRACE_SECONDS_CEILING',
      'KEEP_ALIVE_COUNTDOWN_SECONDS_CEILING',
    ]) {
      expect(table, text).toContain(text);
    }
  });

  it('states the name rule, the restart residuals and the operating assumptions', () => {
    const readme = read('README.md');
    for (const text of [
      'Render them as text, never as HTML',
      'One instance per token secret',
      'NTP',
      'Two restarts in a row',
      'Restart residual',
      'Recovery closure',
      'Automatic handoff gives full control',
    ]) {
      expect(readme.toLowerCase(), text).toContain(text.toLowerCase());
    }
  });

  it('states the token rules after #13: no lifelong take-back, supersede kills stale codes', () => {
    const readme = read('README.md').replace(/\s+/g, ' ');
    // Before #13 any leader token could take the lead back until the end.
    expect(readme).not.toContain('can take the lead back until the group ends');
    for (const text of [
      "A displaced leader's token only rejoins as a member",
      'most recent displaced leader',
      'no code or QR ticket of the stale leader survives',
    ]) {
      expect(readme, text).toContain(text);
    }
  });
});
