import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { hashApiKey } from '../src/apps/app-registry.js';
import { collectAppsConfig } from '../src/config/apps-config.js';
import { ConfigError } from '../src/config/config-error.js';
import { DEV_API_KEYS, devKeyProblems, warnDevKeys } from '../src/config/dev-key.js';
import { collectEnv } from '../src/config/env.js';
import { loadConfig } from '../src/config/load.js';
import { collectRedisSettings } from '../src/config/redis.js';
import { collectTokenSecrets } from '../src/config/token-secret.js';
import { expectNoSentinel, secretFileDir } from './helpers/secret-files.js';

/** Test-only values, never real. */
const STRONG = 'q9Zt2Lx7Vb4Nm1Rt6Yw0Ue5Io3AaKd8Fj2Hs7Gp1Wc=';
const KEY_A = 'key-a-0123456789-0123456789-0123456789';
const KEY_B = 'key-b-0123456789-0123456789-0123456789';
const DEV_KEY = DEV_API_KEYS[0]!;
const devConfigPath = fileURLToPath(new URL('../../../config/apps.dev.json', import.meta.url));

function writeConfig(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'sync-load-'));
  const path = join(dir, 'apps.json');
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

function problemsOf(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig (#36 AC37, AC38)', () => {
  it('returns the whole config when nothing is wrong', () => {
    const config = loadConfig({
      SYNC_CONFIG_PATH: devConfigPath,
      NODE_ENV: 'development',
      TOKEN_SECRET: STRONG,
    });
    expect(config.env.configPath).toBe(devConfigPath);
    expect(config.apps.map((app) => app.namespace)).toEqual(['dev-app']);
    expect(config.tokenSecrets.source).toBe('env');
    expect(config.redis).toBeUndefined();
  });

  it('reports env, Redis, secret, apps-file and dev-key problems together, in a fixed order', () => {
    const path = writeConfig({
      apps: [
        { namespace: 'a', apiKey: DEV_KEY, minAppVersion: '1.0.0' },
        { namespace: 'b', apiKey: KEY_A, minAppVersion: 'not-semver' },
        { namespace: 'c', apiKey: DEV_KEY, minAppVersion: '1.0.0' },
      ],
    });
    const problems = problemsOf({
      SYNC_CONFIG_PATH: path,
      NODE_ENV: 'production',
      PORT: 'x',
      REDIS_KEY_PREFIX: 'Bad:Prefix',
      TOKEN_SECRET: 'short',
    });
    expect(problems).toEqual([
      'PORT must be a positive integer',
      'REDIS_KEY_PREFIX must be 1-32 characters of a-z, 0-9, _ and -, starting with a letter or digit',
      'TOKEN_SECRET must be at least 32 bytes (use `openssl rand -base64 32`)',
      `${path}: apps[1] (namespace "b"): minAppVersion must be a semver string of at most 64 characters`,
      `${path}: apps[2] (namespace "c") has the same apiKey as apps[0] (namespace "a") (each app needs its own key)`,
      'apps[0] (namespace "a") uses the public development API key; set a real key',
    ]);
  });

  it('reports every app with the public dev key, not just the first', () => {
    const path = writeConfig({
      apps: [
        { namespace: 'a', apiKey: DEV_KEY, minAppVersion: '1.0.0' },
        { namespace: 'b', apiKey: KEY_A, minAppVersion: '1.0.0' },
      ],
    });
    const dev = { SYNC_CONFIG_PATH: devConfigPath, TOKEN_SECRET: STRONG, NODE_ENV: 'staging' };
    expect(problemsOf(dev)).toEqual([
      'apps[0] (namespace "dev-app") uses the public development API key; set a real key',
    ]);
    expect(problemsOf({ ...dev, SYNC_CONFIG_PATH: path })).toHaveLength(1);
  });

  it('skips the apps file when SYNC_CONFIG_PATH itself is invalid', () => {
    expect(problemsOf({ SYNC_CONFIG_PATH: ' ', TOKEN_SECRET: STRONG })).toEqual([
      'SYNC_CONFIG_PATH must not be empty',
    ]);
  });

  it('reports a missing apps file with the other problems', () => {
    expect(problemsOf({ SYNC_CONFIG_PATH: '/no/such/apps.json', LOG_LEVEL: 'loud' })).toEqual([
      'LOG_LEVEL must be one of fatal, error, warn, info, debug, trace, silent',
      'TOKEN_SECRET is required (use `openssl rand -base64 32`)',
      '/no/such/apps.json: config file not found (set SYNC_CONFIG_PATH)',
    ]);
  });
});

describe('invalid ceilings (#36 Gate 2 Q-4)', () => {
  const base = { TOKEN_SECRET: STRONG, NODE_ENV: 'test' };

  it('skips only the comparisons that need the invalid ceiling', () => {
    const path = writeConfig({
      apps: [
        {
          namespace: 'a',
          apiKey: KEY_A,
          minAppVersion: '1.0.0',
          maxGroupSize: 500,
          maxMessageBytes: 99999,
        },
      ],
    });
    const problems = problemsOf({ ...base, SYNC_CONFIG_PATH: path, MAX_GROUP_SIZE_CEILING: 'abc' });
    expect(problems).toEqual([
      'MAX_GROUP_SIZE_CEILING must be a positive integer',
      `${path}: apps[0] (namespace "a"): maxMessageBytes 99999 exceeds MAX_MESSAGE_SIZE_CEILING 16384 (lower maxMessageBytes or raise MAX_MESSAGE_SIZE_CEILING)`,
    ]);
  });

  it('still checks an app minimum against an invalid ceiling', () => {
    const path = writeConfig({
      apps: [{ namespace: 'a', apiKey: KEY_A, minAppVersion: '1.0.0', maxGroupSize: 1 }],
    });
    expect(problemsOf({ ...base, SYNC_CONFIG_PATH: path, MAX_GROUP_SIZE_CEILING: '0' })).toEqual([
      'MAX_GROUP_SIZE_CEILING must be a positive integer',
      `${path}: apps[0] (namespace "a"): maxGroupSize must be an integer >= 2`,
    ]);
  });

  it('skips the keep-alive rule when the inactivity limit is defaulted from an invalid ceiling', () => {
    const path = writeConfig({
      apps: [
        { namespace: 'a', apiKey: KEY_A, minAppVersion: '1.0.0', keepAliveCountdownSeconds: 3000 },
      ],
    });
    expect(
      problemsOf({
        ...base,
        SYNC_CONFIG_PATH: path,
        INACTIVITY_LIMIT_MINUTES_CEILING: 'x',
        KEEP_ALIVE_COUNTDOWN_SECONDS_CEILING: '3600',
      }),
    ).toEqual(['INACTIVITY_LIMIT_MINUTES_CEILING must be a positive integer']);
  });

  it('skips JOIN_METHODS_ALLOWED comparisons but still reports duplicate methods', () => {
    const path = writeConfig({
      apps: [
        { namespace: 'a', apiKey: KEY_A, minAppVersion: '1.0.0', joinMethods: ['B', 'C'] },
        { namespace: 'b', apiKey: KEY_B, minAppVersion: '1.0.0', joinMethods: ['A', 'A'] },
      ],
    });
    const problems = problemsOf({ ...base, SYNC_CONFIG_PATH: path, JOIN_METHODS_ALLOWED: 'Z' });
    expect(problems).toEqual([
      'JOIN_METHODS_ALLOWED must be a non-empty comma-separated list of distinct methods A, B, C, D',
      `${path}: apps[1] (namespace "b"): joinMethods must be a non-empty array of distinct methods "A", "B", "C", "D"`,
    ]);
  });
});

describe('collectors never fall back after a problem (#36 security C1)', () => {
  it('collectEnv returns no env, and undefined for a failed ceiling', () => {
    const problems: string[] = [];
    const collected = collectEnv({ MAX_GROUP_SIZE_CEILING: 'x' }, problems);
    expect(problems).toHaveLength(1);
    expect(collected.env).toBeUndefined();
    expect(collected.ceilings.maxGroupSizeCeiling).toBeUndefined();
    expect(collected.ceilings.maxMessageSizeCeiling).toBe(16384);
  });

  it('collectEnv returns no Redis settings when any env problem was found', () => {
    const problems: string[] = [];
    const collected = collectEnv({ REDIS_URL: 'redis://localhost:6379', PORT: 'x' }, problems);
    expect(collected.redis).toBeUndefined();
  });

  it('collectRedisSettings returns undefined when a REDIS_* setting next to a valid URL failed', () => {
    const problems: string[] = [];
    const settings = collectRedisSettings(
      { REDIS_URL: 'redis://localhost:6379', REDIS_COMMAND_TIMEOUT_MS: '5' },
      problems,
    );
    expect(problems).toEqual(['REDIS_COMMAND_TIMEOUT_MS must be an integer between 100 and 30000']);
    expect(settings).toBeUndefined();
  });

  it('collectTokenSecrets returns undefined, never a random secret, after a problem', () => {
    for (const env of [
      { TOKEN_SECRET: 'short' },
      { TOKEN_SECRET: STRONG, TOKEN_SECRET_PREVIOUS: STRONG },
      { TOKEN_SECRET_PREVIOUS: 'short' },
    ]) {
      const problems: string[] = [];
      expect(collectTokenSecrets(env, 'development', problems)).toBeUndefined();
      expect(problems.length).toBeGreaterThan(0);
    }
  });

  it('collectAppsConfig returns undefined when the file as a whole is unusable', () => {
    const problems: string[] = [];
    const ceilings = collectEnv({}, []).ceilings;
    expect(collectAppsConfig('{', ceilings, 'apps.json', problems)).toBeUndefined();
    expect(collectAppsConfig('[]', ceilings, 'apps.json', problems)).toBeUndefined();
    expect(collectAppsConfig('{"apps":[]}', ceilings, 'apps.json', problems)).toBeUndefined();
    expect(problems).toHaveLength(3);
  });
});

describe('devKeyProblems and warnDevKeys', () => {
  const apps = [DEV_KEY, KEY_A, DEV_KEY].map((key, index) => ({
    namespace: `n${index}`,
    apiKeyHash: hashApiKey(key),
  }));
  type Apps = Parameters<typeof devKeyProblems>[0];

  it('reports every app with the dev key outside development and test', () => {
    expect(devKeyProblems(apps as unknown as Apps, 'production')).toEqual([
      'apps[0] (namespace "n0") uses the public development API key; set a real key',
      'apps[2] (namespace "n2") uses the public development API key; set a real key',
    ]);
    expect(devKeyProblems(apps as unknown as Apps, 'development')).toEqual([]);
  });

  it('warns once per dev-key app with the namespace only', () => {
    const lines: unknown[] = [];
    warnDevKeys(apps as unknown as Apps, { warn: (obj) => lines.push(obj) });
    expect(lines).toEqual([
      { event: 'dev_api_key', namespace: 'n0' },
      { event: 'dev_api_key', namespace: 'n2' },
    ]);
  });
});

describe('loadConfig with secret files (#58 AC7, security C9)', () => {
  const files = secretFileDir('sync-load-secret-');
  afterAll(() => files.cleanup());
  /** Test-only values, never real. */
  const SECRET = 'SENTINEL-load-Qm7Zx2Lv9Kd4Rt8Wn3Hb6Jf1Pc0Ys5';
  const PREVIOUS = 'SENTINEL-load2-Hb6Jf1Pc0Ys5Qm7Zx2Lv9Kd4Rt8Wn';
  const REDIS_PASSWORD = 'SENTINEL-load-redis-pw';

  it('never renders a secret in JSON or inspect output of the loaded config', () => {
    const config = loadConfig({
      SYNC_CONFIG_PATH: devConfigPath,
      NODE_ENV: 'development',
      TOKEN_SECRET_FILE: files.file('token', `${SECRET}\n`),
      TOKEN_SECRET_PREVIOUS_FILE: files.file('previous', `${PREVIOUS}\r\n`),
      REDIS_URL_FILE: files.file('redis', `redis://:${REDIS_PASSWORD}@redis.internal:6379\n`),
    });
    expect(config.tokenSecrets.source).toBe('file');
    expect(config.redis?.hasPassword).toBe(true);
    const text = [
      JSON.stringify(config),
      inspect(config, { depth: 10 }),
      inspect(config, { depth: 10, showHidden: true }),
      JSON.stringify(config.tokenSecrets),
      inspect(config.tokenSecrets),
      JSON.stringify(config.redis),
      inspect(config.redis),
    ].join('\n');
    for (const sentinel of [SECRET, PREVIOUS, REDIS_PASSWORD]) expectNoSentinel(text, sentinel);
  });
});
