import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config/config-error.js';
import {
  KNOWN_SERVER_VARIABLES,
  PLATFORM_SUFFIXES,
  collectUnknownVariables,
  editDistance,
  isServerFamilyName,
  unknownServerVariables,
} from '../src/config/known-vars.js';
import { loadConfig } from '../src/config/load.js';
import { run } from '../src/main.js';
import { childEnv } from './helpers/child-env.js';
import { LogCapture } from './helpers/log-capture.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const devConfigPath = join(repoRoot, 'config', 'apps.dev.json');
/** Test-only value, never real. */
const STRONG = 'q9Zt2Lx7Vb4Nm1Rt6Yw0Ue5Io3AaKd8Fj2Hs7Gp1Wc=';
const README_HINT =
  'remove it or fix the name (see "Environment variables" in docs/operator-guide.md)';

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function problemsOf(env: Record<string, string>): string[] {
  const problems: string[] = [];
  collectUnknownVariables(env, problems);
  return problems;
}

/**
 * The uncommented `KEY: value` lines of one service's `environment:` map in
 * a compose file. Values lose their quotes.
 */
function composeEnvironment(file: string, service: string): Record<string, string> {
  const text = read(file);
  const start = text.search(new RegExp(`^ {2}${service}:$`, 'm'));
  expect(start, `${file} ${service}`).toBeGreaterThanOrEqual(0);
  const block = text.slice(start).split('\n').slice(1);
  const env: Record<string, string> = {};
  let inside = false;
  for (const line of block) {
    if (/^ {2}\S/.test(line)) break;
    if (/^ {4}environment:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside || /^\s*#/.test(line)) continue;
    const match = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/.exec(line);
    if (!match) {
      inside = false;
      continue;
    }
    env[match[1]!] = match[2]!.replace(/^'(.*)'$/, '$1');
  }
  return env;
}

/** A compose env as the server would see it, with the mounted registry replaced by the dev one. */
function asLocal(env: Record<string, string>): Record<string, string> {
  return { ...env, SYNC_CONFIG_PATH: devConfigPath };
}

describe('unknown look-alike variables (#36 AC37a, ADR 0015)', () => {
  it('flags a typo with a suggestion and never prints the value', () => {
    expect(problemsOf({ MAX_GROUP_SIZE_CIELING: 'SENTINEL-typo-value' })).toEqual([
      'MAX_GROUP_SIZE_CIELING is not a sync server variable; did you mean MAX_GROUP_SIZE_CEILING?',
    ]);
  });

  it('flags a typo of a group creation limit with its suggestion (#12 R15)', () => {
    expect(problemsOf({ MAX_GROUP_CREATE_BURST_PERAPP: '500' })).toEqual([
      'MAX_GROUP_CREATE_BURST_PERAPP is not a sync server variable; did you mean MAX_GROUP_CREATE_BURST_PER_APP?',
    ]);
    expect(problemsOf({ MAX_LIVE_GROUP_PER_APP: '1' })).toEqual([
      'MAX_LIVE_GROUP_PER_APP is not a sync server variable; did you mean MAX_LIVE_GROUPS_PER_APP?',
    ]);
  });

  it('reports the typo together with every other problem and exits 1', async () => {
    let stderr = '';
    const logs = new LogCapture();
    const result = await run(
      {
        SYNC_CONFIG_PATH: devConfigPath,
        NODE_ENV: 'test',
        TOKEN_SECRET: STRONG,
        MAX_GROUP_SIZE_CIELING: 'SENTINEL-typo-value',
        LOG_LEVEL: 'loud',
      },
      { stderr: (text) => (stderr += text), destination: logs },
    );
    expect(result).toEqual({ ok: false, exitCode: 1 });
    expect(stderr).toBe(
      'Config error: LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent\n' +
        'Config error: MAX_GROUP_SIZE_CIELING is not a sync server variable; did you mean MAX_GROUP_SIZE_CEILING?\n',
    );
    expect(stderr).not.toContain('SENTINEL');
    expect(logs.text).toBe('');
  });

  it('flags look-alikes without a close known name, without a suggestion', () => {
    expect(
      problemsOf({ REDIS_PASSWORD: 'SENTINEL-pw', MAX_GROUP_SIZE: '5', SYNC_DEBUG: '1' }),
    ).toEqual([
      `MAX_GROUP_SIZE is not a sync server variable; ${README_HINT}`,
      `REDIS_PASSWORD is not a sync server variable; ${README_HINT}`,
      `SYNC_DEBUG is not a sync server variable; ${README_HINT}`,
    ]);
  });

  it('knows only the three _FILE names; other _FILE names in a family are still flagged (#58, ADR 0024)', () => {
    expect(
      problemsOf({
        TOKEN_SECRET_FILE: 'x',
        TOKEN_SECRET_PREVIOUS_FILE: 'x',
        REDIS_URL_FILE: 'x',
        MAX_X_FILE: 'SENTINEL-a',
        REDIS_PASSWORD_FILE: 'SENTINEL-b',
        TOKEN_SECRET_FILES: 'SENTINEL-c',
        TOKEN_SECRET_FIEL: 'SENTINEL-d',
        PORT_FILE: 'x',
      }),
    ).toEqual([
      `MAX_X_FILE is not a sync server variable; ${README_HINT}`,
      `REDIS_PASSWORD_FILE is not a sync server variable; ${README_HINT}`,
      'TOKEN_SECRET_FIEL is not a sync server variable; did you mean TOKEN_SECRET_FILE?',
      'TOKEN_SECRET_FILES is not a sync server variable; did you mean TOKEN_SECRET_FILE?',
    ]);
  });

  it('flags lower-case and mixed-case names in a family', () => {
    expect(problemsOf({ redis_url: 'x', Token_Secret: 'y' })).toEqual([
      'Token_Secret is not a sync server variable; did you mean TOKEN_SECRET?',
      'redis_url is not a sync server variable; did you mean REDIS_URL?',
    ]);
  });

  it('flags the _CEILING suffix outside the prefixes', () => {
    expect(problemsOf({ GROUP_SIZE_CEILING: '1' })).toEqual([
      `GROUP_SIZE_CEILING is not a sync server variable; ${README_HINT}`,
    ]);
  });

  it('cuts a long name at 48 characters and gives no suggestion for it', () => {
    const name = `MAX_${'A'.repeat(60)}`;
    expect(problemsOf({ [name]: 'x' })).toEqual([
      `${name.slice(0, 48)}... is not a sync server variable; ${README_HINT}`,
    ]);
  });

  it('sorts the lines by name and ignores unset entries', () => {
    expect(unknownServerVariables({ TOKEN_X: '1', MAX_X: '1', REDIS_X: undefined })).toEqual([
      'MAX_X',
      'TOKEN_X',
    ]);
  });

  it('suggests within 2 edits only (Damerau-Levenshtein, case-insensitive)', () => {
    expect(editDistance('REDIS_URL', 'redis_url')).toBe(0);
    expect(editDistance('REDIS_ULR', 'REDIS_URL')).toBe(1);
    expect(editDistance('MAX_CONECTION', 'MAX_CONNECTIONS')).toBe(2);
    expect(problemsOf({ MAX_CONECTION: '1' })).toEqual([
      'MAX_CONECTION is not a sync server variable; did you mean MAX_CONNECTIONS?',
    ]);
    expect(problemsOf({ MAX_CONECTIO: '1' })).toEqual([
      `MAX_CONECTIO is not a sync server variable; ${README_HINT}`,
    ]);
  });

  it('considers only names of the shape [A-Za-z][A-Za-z0-9_]*', () => {
    expect(isServerFamilyName('MAX-GROUP')).toBe(false);
    expect(isServerFamilyName('_MAX_X')).toBe(false);
    expect(isServerFamilyName('9MAX_X')).toBe(false);
    expect(problemsOf({ 'MAX_X=1': 'y', 'MAX X': 'y' })).toEqual([]);
  });
});

describe('no false positives (#36 AC37a, AC41)', () => {
  it('never flags a known variable', () => {
    expect(KNOWN_SERVER_VARIABLES).toHaveLength(37);
    expect(
      problemsOf(Object.fromEntries(KNOWN_SERVER_VARIABLES.map((name) => [name, 'x']))),
    ).toEqual([]);
  });

  it('loads the sync-server env of every compose file with no problem', () => {
    const base = composeEnvironment('compose.yaml', 'sync-server');
    const redis = composeEnvironment('compose.redis.yaml', 'sync-server');
    const second = composeEnvironment('compose.multi.yaml', 'sync-server-2');
    expect(Object.keys(base)).toContain('TOKEN_SECRET');
    expect(Object.keys(redis)).toContain('REDIS_URL');
    expect(Object.keys(second)).toContain('REDIS_URL');
    for (const env of [base, { ...base, ...redis }, { ...base, ...second }]) {
      expect(() => loadConfig(asLocal(env))).not.toThrow();
    }
  });

  it('does not flag the ENV lines of either Dockerfile', () => {
    for (const file of ['apps/sync-server/Dockerfile', 'apps/reader/Dockerfile']) {
      const names = [...read(file).matchAll(/^ENV\s+([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(
        (m) => m[1]!,
      );
      expect(names.length, file).toBeGreaterThan(0);
      expect(problemsOf(Object.fromEntries(names.map((name) => [name, 'x']))), file).toEqual([]);
    }
  });

  it('does not flag the env names of the CI workflow or the test harness', () => {
    const ci = read('.github/workflows/ci.yml');
    const names = [...ci.matchAll(/^\s+([A-Z][A-Z0-9_]*):\s+\S/gm)]
      .map((m) => m[1]!)
      .filter((name) => /^[A-Z][A-Z0-9_]+$/.test(name));
    expect(names).toContain('SYNC_TEST_REDIS_URL');
    expect(problemsOf(Object.fromEntries(names.map((name) => [name, 'x'])))).toEqual([]);
    expect(
      problemsOf({ SYNC_TEST_STORE: 'redis', SYNC_TEST_REDIS_URL: 'x', sync_test_x: '1' }),
    ).toEqual([]);
  });

  it('does not flag runtime names of node, pnpm and vitest', () => {
    const env = {
      NODE_VERSION: '24',
      YARN_VERSION: '1',
      HOSTNAME: 'h',
      HOME: '/home/node',
      PATH: '/bin',
      CI: 'true',
      VITEST: 'true',
      VITEST_POOL_ID: '1',
      TEST: 'true',
      npm_config_x: 'y',
      npm_lifecycle_event: 'test',
    };
    expect(problemsOf(env)).toEqual([]);
  });

  it('does not flag Kubernetes service links for redis, sync and sync-server', () => {
    const names: string[] = [];
    for (const service of ['REDIS', 'SYNC', 'SYNC_SERVER']) {
      names.push(
        `${service}_SERVICE_HOST`,
        `${service}_SERVICE_PORT`,
        `${service}_SERVICE_PORT_REDIS`,
        `${service}_SERVICE_PORT_HTTP`,
        `${service}_PORT`,
        `${service}_PORT_6379_TCP`,
        `${service}_PORT_6379_TCP_ADDR`,
        `${service}_PORT_6379_TCP_PORT`,
        `${service}_PORT_6379_TCP_PROTO`,
        `${service}_PORT_8080_UDP`,
        `${service}_PORT_8080_SCTP_ADDR`,
      );
    }
    expect(problemsOf(Object.fromEntries(names.map((name) => [name, 'x'])))).toEqual([]);
  });

  it('does not flag Docker --link names', () => {
    expect(
      problemsOf({
        REDIS_NAME: '/app/redis',
        REDIS_ENV_REDIS_VERSION: '7.2',
        SYNC_ENV_NODE_ENV: 'production',
      }),
    ).toEqual([]);
  });

  it('pins the platform suffix list (the reader keeps the same copy)', () => {
    expect(PLATFORM_SUFFIXES.map(String)).toEqual([
      '/_SERVICE_HOST$/',
      '/_SERVICE_PORT$/',
      '/_SERVICE_PORT_[A-Z0-9_]+$/',
      '/_PORT$/',
      '/_PORT_[0-9]+_(TCP|UDP|SCTP)(_(ADDR|PORT|PROTO))?$/',
      '/_NAME$/',
      '/_ENV_[A-Z0-9_]+$/',
    ]);
  });
});

describe('childEnv (spawned servers)', () => {
  it('drops every family name from the parent env and keeps the rest', () => {
    const saved = { ...process.env };
    try {
      process.env.MAX_GROUP_SIZE_CIELING = 'x';
      process.env.REDIS_URL = 'redis://parent';
      process.env.SYNC_TEST_STORE = 'memory';
      const env = childEnv({ PORT: '1' });
      expect(env.MAX_GROUP_SIZE_CIELING).toBeUndefined();
      expect(env.REDIS_URL).toBeUndefined();
      expect(env.SYNC_TEST_STORE).toBe('memory');
      expect(env.PORT).toBe('1');
      expect(env.PATH ?? env.Path).toBe(process.env.PATH ?? process.env.Path);
    } finally {
      for (const name of Object.keys(process.env)) {
        if (!(name in saved)) delete process.env[name];
      }
      Object.assign(process.env, saved);
    }
  });

  it('never adds a name beyond the parent env and extra', () => {
    const env = childEnv({ EXTRA_NAME: '1' });
    for (const name of Object.keys(env)) {
      expect(name in process.env || name === 'EXTRA_NAME', name).toBe(true);
    }
  });
});

describe('loadConfig with unknown names', () => {
  it('fails closed: an unknown name alone stops the load', () => {
    let error: unknown;
    try {
      loadConfig({
        SYNC_CONFIG_PATH: devConfigPath,
        NODE_ENV: 'test',
        TOKEN_SECRET: STRONG,
        TOKEN_SECERT: 'SENTINEL',
      });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual([
      'TOKEN_SECERT is not a sync server variable; did you mean TOKEN_SECRET?',
    ]);
  });
});
