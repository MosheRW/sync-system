import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KNOWN_SERVER_VARIABLES } from '../src/config/known-vars.js';
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

/**
 * The trigger keys of a workflow's `on:` block (#54, ADR 0018): `keys` are
 * the active ones, `commented` the `# key:` lines. The block ends at the
 * first non-empty line that is not indented, so keys elsewhere don't count.
 */
function workflowTriggers(workflow: string): { keys: string[]; commented: string[] } {
  const lines = workflow.split(/\r?\n/);
  const keys: string[] = [];
  const commented: string[] = [];
  const start = lines.indexOf('on:');
  if (start === -1) return { keys, commented };
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith('  ')) break;
    const key = /^ {2}([a-z_]+):/.exec(line)?.[1];
    if (key) keys.push(key);
    const off = /^ {2}# ([a-z_]+):/.exec(line)?.[1];
    if (off) commented.push(off);
  }
  return { keys, commented };
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

describe('image license and labels (#37 C8, ADR 0017)', () => {
  const dockerfile = read('apps/sync-server/Dockerfile');
  const runtime = dockerfile.slice(dockerfile.search(/^FROM\s.*\sAS runtime$/m));

  it('copies the single LICENSE file into the runtime stage only', () => {
    const licenseCopies = dockerfile
      .split(/\r?\n/)
      .filter((line) => /^COPY\s/.test(line) && /LICENSE/.test(line));
    expect(licenseCopies).toEqual(['COPY LICENSE ./LICENSE']);
    expect(runtime).toMatch(/^COPY LICENSE \.\/LICENSE$/m);
  });

  it('has the static OCI labels and no version or revision label', () => {
    expect(runtime).toContain(
      'org.opencontainers.image.source="https://github.com/MosheRW/sync-system"',
    );
    expect(runtime).toContain('org.opencontainers.image.licenses="GPL-3.0-only"');
    expect(runtime).toContain('org.opencontainers.image.title=');
    expect(runtime).toContain('org.opencontainers.image.description=');
    expect(dockerfile).not.toMatch(/org\.opencontainers\.image\.(version|revision)/);
  });

  it('has no ARG or ENV that carries a credential', () => {
    const names = dockerfile
      .split(/\r?\n/)
      .filter((line) => /^(ARG|ENV)\s/.test(line))
      .map((line) => line.replace(/^(ARG|ENV)\s+/, '').split(/[=\s]/)[0] ?? '');
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name, name).not.toMatch(/TOKEN|SECRET|PASSWORD|KEY/i);
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

  it('keeps package.json in the runtime image, next to dist/ (#36 AC33)', () => {
    const dockerfile = read('apps/sync-server/Dockerfile');
    const runtime = dockerfile.slice(dockerfile.search(/^FROM\s.*\sAS runtime$/m));
    const copies = runtime.split(/\r?\n/).filter((line) => /^COPY\s/.test(line));
    // Either the whole `pnpm deploy` output (which always holds package.json)
    // or package.json by name.
    const whole = copies.some((line) => /^COPY\s+--from=build\s+\/out\/?\s+\.\/?$/.test(line));
    const explicit = copies.some((line) => /package\.json/.test(line));
    expect(whole || explicit, copies.join('\n')).toBe(true);
    expect(dockerfile).toMatch(
      /pnpm --filter @mosherw\/sync-system-server deploy --prod --legacy \/out/,
    );
    expect(runtime).toMatch(/^CMD \["node", "dist\/index\.js"\]$/m);
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

describe('two-instance compose example (#35 AC23, security P2-8)', () => {
  const multi = read('compose.multi.yaml');
  const nginx = read('config/nginx-multi.conf');
  /** One service block of compose.multi.yaml. */
  const service = (name: string): string => {
    const start = multi.indexOf(`\n  ${name}:`);
    const rest = multi.slice(start + 1);
    const next = rest.search(/\n {2}[a-z][a-z0-9-]*:/);
    return next === -1 ? rest : rest.slice(0, next);
  };

  it('pins the unprivileged nginx image by digest', () => {
    expect(service('lb')).toMatch(
      /image: nginxinc\/nginx-unprivileged:[0-9.]+-alpine@sha256:[0-9a-f]{64}$/m,
    );
  });

  it('publishes only the load balancer, on loopback; both servers have no host port', () => {
    expect(service('lb')).toContain("- '127.0.0.1:8080:8080'");
    expect(service('sync-server')).toMatch(/ports: !reset \[\]/);
    expect(service('sync-server-2')).toMatch(/ports: !reset \[\]/);
    expect(multi.match(/^\s+ports:/gm)).toHaveLength(3);
    expect(multi).not.toContain('0.0.0.0:');
  });

  it('locks the load balancer down and keeps the Redis rules of compose.redis.yaml', () => {
    const lb = service('lb');
    expect(lb).toMatch(/read_only: true/);
    expect(lb).toMatch(/cap_drop:\s*\n\s+- ALL/);
    expect(lb).toContain('no-new-privileges:true');
    expect(lb).toContain('./config/nginx-multi.conf:/etc/nginx/conf.d/default.conf:ro');
    // Redis is not redefined here: the C3 and C5 rules above still hold.
    expect(multi).not.toMatch(/^ {2}redis:/m);
    const url = /REDIS_URL:\s*(\S+)/.exec(service('sync-server-2'))?.[1];
    expect(url).toBe(`redis://:${DEV_REDIS_PASSWORD}@redis:6379`);
    // The second instance reuses the first one's image (no second build).
    expect(service('sync-server-2')).toMatch(/build: !reset null/);
    expect(service('sync-server-2')).toContain('image: sync-system/sync-server:dev');
  });

  it('balances round robin with the WebSocket upgrade, no stickiness and no access log', () => {
    expect(nginx).toMatch(/proxy_http_version 1\.1;/);
    expect(nginx).toMatch(/proxy_set_header Upgrade \$http_upgrade;/);
    expect(nginx).toMatch(/proxy_set_header Connection \$connection_upgrade;/);
    expect(nginx).toMatch(/proxy_read_timeout 120s;/);
    // One rotation for all worker processes, and a stopped instance skipped fast.
    expect(nginx).toMatch(/^\s*zone sync_servers \d+k;/m);
    expect(nginx).toMatch(/proxy_connect_timeout 2s;/);
    expect(nginx).toMatch(/access_log off;/);
    expect(nginx).toContain('server sync-server:8080;');
    expect(nginx).toContain('server sync-server-2:8080;');
    const directives = nginx
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    for (const sticky of [/\bip_hash\b/, /\bhash\b/, /\bsticky\b/]) {
      expect(directives).not.toMatch(sticky);
    }
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

  it('runs on push and pull_request, or is explicitly paused (#54), with a read-only token and no secrets', () => {
    const { keys, commented } = workflowTriggers(workflow);
    expect(keys.length, 'trigger keys under on:').toBeGreaterThan(0);
    for (const key of keys) {
      expect(['push', 'pull_request', 'workflow_dispatch'], `trigger ${key}`).toContain(key);
    }
    // ADR 0018: exactly one of two states; the marker says which one is expected.
    if (workflow.includes('# CI paused (#54):')) {
      expect(keys, 'paused (marker present): only workflow_dispatch').toEqual([
        'workflow_dispatch',
      ]);
      expect(commented, 'paused (marker present): # push: and # pull_request:').toEqual(
        expect.arrayContaining(['push', 'pull_request']),
      );
    } else {
      expect(keys, 'active (no marker): push and pull_request').toEqual(
        expect.arrayContaining(['push', 'pull_request']),
      );
    }
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

  it('checks the three compose files and gives the check job 25 minutes (#35 AC23, AC31)', () => {
    const check = workflow.slice(workflow.indexOf('  check:'), workflow.indexOf('  e2e:'));
    expect(check).toMatch(/timeout-minutes: 25/);
    const compose = check.slice(check.indexOf('name: Compose files'), check.indexOf('name: Build'));
    for (const files of [
      '-f compose.yaml config -q',
      '-f compose.yaml -f compose.redis.yaml config -q',
      '-f compose.yaml -f compose.redis.yaml -f compose.multi.yaml config -q',
    ]) {
      expect(compose).toContain(`docker compose ${files}`);
    }
  });

  it('installs from the lockfile, audits, then runs every check', () => {
    const steps = [
      'pnpm install --frozen-lockfile',
      'pnpm audit --audit-level=high',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build',
      'pnpm pack:check',
      'pnpm smoke',
    ];
    let last = -1;
    for (const step of steps) {
      const index = workflow.indexOf(`run: ${step}`);
      expect(index, step).toBeGreaterThan(last);
      last = index;
    }
    // Pack and smoke run in the check job, after its Build (#37 AC56).
    expect(last).toBeLessThan(workflow.indexOf('  e2e:'));
  });
});

describe('operator guide documents the lifecycle (#13 AC4, AC38, RC14)', () => {
  it('has one timers table with every timer, default and env ceiling', () => {
    const readme = read('docs/operator-guide.md');
    const table = readme.slice(readme.indexOf('## Timers'), readme.indexOf('## Roles and'));
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
    const readme = read('docs/operator-guide.md');
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

  it('documents every REDIS_* variable and the Redis operating rules (#35 AC32)', () => {
    const readme = read('docs/operator-guide.md');
    const table = readme.slice(
      readme.indexOf('## Environment variables'),
      readme.indexOf('## Storage (Redis)'),
    );
    for (const name of [
      'REDIS_URL',
      'REDIS_KEY_PREFIX',
      'REDIS_CONNECT_TIMEOUT_SECONDS',
      'REDIS_COMMAND_TIMEOUT_MS',
    ]) {
      expect(table, name).toContain(`| \`${name}\``);
    }
    const storage = readme
      .slice(readme.indexOf('## Storage (Redis)'), readme.indexOf('## Joining'))
      .replace(/\s+/g, ' ');
    for (const text of [
      'Any number of sync server instances can share one Redis and key prefix',
      'noeviction',
      'No persistence',
      'ACL SETUSER',
      'Startup error: Redis is unreachable (REDIS_URL)',
      '`1001`',
      'HTTP 503',
      'Limits stay per instance',
    ]) {
      expect(storage, text).toContain(text);
    }
  });

  it('documents several instances, the compose example and the join budget (#35 AC6, AC22, AC23, AC32)', () => {
    const readme = read('docs/operator-guide.md');
    expect(readme).not.toContain('One instance only');
    expect(readme).toMatch(/^## Several instances$/m);
    const flat = readme.replace(/\s+/g, ' ');
    for (const text of [
      'compose.multi.yaml',
      'The join-attempt budget multiplies by the number of instances.',
      'issue #41',
      'stop every instance before starting the new ones',
      'An outage longer than 10 seconds closes every group session of the instance with `1001`',
      'including leader-only frames with display names',
      '+publish +subscribe +unsubscribe +ping',
      'No sticky sessions are needed',
    ]) {
      expect(flat, text).toContain(text);
    }
    expect(flat).not.toContain('+@pubsub`');
  });

  it('states the token rules after #13: no lifelong take-back, supersede kills stale codes', () => {
    const readme = read('docs/operator-guide.md').replace(/\s+/g, ' ');
    // Before #13 any leader token could take the lead back until the end.
    expect(readme).not.toContain('can take the lead back until the group ends');
    for (const text of [
      "A displaced leader's token only rejoins as a member",
      'the leader displaced by the last handoff',
      'A take-back cannot be taken back',
      'no code or QR ticket of the stale leader survives',
    ]) {
      expect(readme, text).toContain(text);
    }
  });
});

describe('operator guide documents health, readiness and config errors (#36 AC36, AC40, AC41)', () => {
  const readme = read('docs/operator-guide.md');

  it('lists exactly the known server variables in the env table', () => {
    const table = readme.slice(
      readme.indexOf('## Environment variables'),
      readme.indexOf('## Storage (Redis)'),
    );
    const names = [...table.matchAll(/^\| `([A-Z][A-Z0-9_]*)` +\|/gm)].map((m) => m[1]);
    expect([...names].sort()).toEqual([...KNOWN_SERVER_VARIABLES].sort());
  });

  it('documents /ready for load balancers and why /health must not route', () => {
    const section = readme.slice(
      readme.indexOf('## Health and readiness'),
      readme.indexOf('## Config file'),
    );
    expect(section).toContain('GET /ready');
    expect(section).toContain('{"status":"not_ready","storage":"<kind>"}');
    expect(section).toContain('Do not route on `/health`');
    expect(section).toContain('only from the load balancer');
  });

  it('keeps /health as the compose healthcheck', () => {
    for (const file of ['compose.yaml']) {
      const compose = read(file);
      expect(compose).toContain("fetch('http://127.0.0.1:8080/health')");
      expect(compose).not.toContain('/ready');
    }
  });

  it('states the unknown-variable rule in the upgrade notes and links the startup-error list', () => {
    const upgrading = readme.slice(
      readme.indexOf('## Upgrading'),
      readme.indexOf('## Token secret'),
    );
    expect(upgrading).toContain('Unknown look-alike variables now stop startup');
    expect(upgrading).toContain('REDIS_PASSWORD');
    expect(upgrading).toContain('REDIS_HOST');
    expect(upgrading).toContain('rename them outside');
    expect(readme).toContain('[`docs/startup-errors.md`](startup-errors.md)');
    expect(readme).toContain('](decisions/0015-unknown-environment-variables.md)');
  });
});

/** The bodies of every fenced code block in a Markdown file (#51). */
function codeBlocks(markdown: string): string[] {
  const text = markdown.replace(/\r\n/g, '\n');
  return [...text.matchAll(/^ *```[^\n]*\n([\s\S]*?)^ *```/gm)].map((m) => m[1] ?? '');
}

/** A secret on the docker command line: `-e`, `--env`, `--env=`, quoted or glued (#51 M4). */
const SECRET_ON_COMMAND_LINE =
  /(?:^|\s)(?:-e|--env)(?:\s+|=)?["']?(TOKEN_SECRET(_PREVIOUS)?|REDIS_URL)\b/m;

/** A secret assignment (`NAME: value`, `NAME=value`, `- NAME=value`); group 2 is the value. */
const SECRET_ASSIGNMENT =
  /^\s*(?:-\s*)?["']?(TOKEN_SECRET(?:_PREVIOUS)?|REDIS_URL)["']?\s*[:=]\s*(.*)$/gm;

/** Values that never hold a secret: interpolation, a generated one, or a secret file. */
function isSafeSecretValue(value: string): boolean {
  return ['${', '"$(openssl rand ', '"$$(cat /run/secrets/'].some((prefix) =>
    value.startsWith(prefix),
  );
}

/** The assignments in `block` that set a secret to a literal value. */
function literalSecrets(block: string): string[] {
  return [...block.matchAll(SECRET_ASSIGNMENT)]
    .filter((m) => !isSafeSecretValue(m[2] ?? ''))
    .map((m) => m[0].trim());
}

describe('operator guide passes secrets safely (#51)', () => {
  const guide = read('docs/operator-guide.md');
  const blocks = codeBlocks(guide);

  it('has guards that catch what they are meant to catch (self-check)', () => {
    for (const bad of [
      'docker run -e TOKEN_SECRET=x img',
      'docker run -e "TOKEN_SECRET=x" img',
      "docker run -e'TOKEN_SECRET_PREVIOUS=x' img",
      'docker run -eREDIS_URL=x img',
      'docker run --env "REDIS_URL=x" img',
      'docker run --env=TOKEN_SECRET=x img',
      '  -e TOKEN_SECRET="$(cat /run/secrets/x)" img',
    ]) {
      expect(SECRET_ON_COMMAND_LINE.test(bad), bad).toBe(true);
    }
    for (const ok of [
      'docker run --env-file "$HOME/sync-server.env" img',
      '-e SYNC_CONFIG_PATH=/x',
    ]) {
      expect(SECRET_ON_COMMAND_LINE.test(ok), ok).toBe(false);
    }
    expect(literalSecrets('    TOKEN_SECRET: abc')).toHaveLength(1);
    expect(literalSecrets("      - 'REDIS_URL=redis://:pw@redis:6379'")).toHaveLength(1);
    expect(literalSecrets('      - TOKEN_SECRET_PREVIOUS=abc')).toHaveLength(1);
    expect(literalSecrets('    TOKEN_SECRET: ${TOKEN_SECRET:?set it}')).toHaveLength(0);
    expect(literalSecrets('        TOKEN_SECRET="$$(cat /run/secrets/s)" &&')).toHaveLength(0);
  });

  it('passes no secret with -e or --env in any example', () => {
    expect(blocks.length).toBeGreaterThan(5);
    for (const block of blocks) {
      expect(SECRET_ON_COMMAND_LINE.exec(block)?.[0] ?? null, block).toBeNull();
    }
  });

  it('sets no secret to a literal value in any example', () => {
    expect(blocks.some((block) => block.includes('/run/secrets/sync_token_secret'))).toBe(true);
    for (const block of blocks) {
      expect(literalSecrets(block), block).toEqual([]);
    }
  });

  it('documents the env file, its exposure, the secret file and the missing _FILE variant', () => {
    const section = guide.slice(guide.indexOf('## Token secret'), guide.indexOf('## Timers'));
    expect(section).toMatch(/^### Passing secrets to the container$/m);
    for (const text of [
      '--env-file',
      'docker inspect',
      '600',
      'TOKEN_SECRET_FILE',
      '/run/secrets/',
    ]) {
      expect(section, text).toContain(text);
    }
  });
});
