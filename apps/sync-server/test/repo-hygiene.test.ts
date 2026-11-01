import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
