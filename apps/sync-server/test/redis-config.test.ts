import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config/config-error.js';
import { parseEnv } from '../src/config/env.js';
import { DEV_REDIS_PASSWORD, parseRedisSettings } from '../src/config/redis.js';
import { SECRET_FILE_MESSAGES } from '../src/config/secret-file.js';
import { expectNoSentinel, secretFileDir } from './helpers/secret-files.js';

const USER = 'SENTINELuser';
const PASSWORD = 'SENTINEL-pass-word';
const HOST = 'sentinel-host.example';

function errorOf(env: Record<string, string>): string {
  try {
    parseEnv(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.message;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

/** No part of the URL appears in `text` (AC3, security C9). */
function expectNoUrlParts(text: string): void {
  for (const part of [USER, PASSWORD, HOST, '6390', '%E0', '@']) {
    expect(text).not.toContain(part);
  }
}

describe('REDIS_* settings (#35 AC2, AC3)', () => {
  it('is the memory store when REDIS_URL is unset', () => {
    expect(parseRedisSettings({})).toBeUndefined();
    expect(parseEnv({})).not.toHaveProperty('redisUrl');
  });

  it.each([
    [`redis://${USER}:${PASSWORD}@${HOST}:6390/2`, false, USER, PASSWORD, 6390, 2],
    [`redis://:${PASSWORD}@${HOST}`, false, undefined, PASSWORD, 6379, 0],
    [`rediss://${HOST}:6390`, true, undefined, undefined, 6390, 0],
    [`redis://${HOST}/`, false, undefined, undefined, 6379, 0],
    [`redis://${HOST}/0`, false, undefined, undefined, 6379, 0],
    [`redis://${HOST}/15`, false, undefined, undefined, 6379, 15],
    [`redis://:p%40ss%3Aw@${HOST}`, false, undefined, 'p@ss:w', 6379, 0],
  ])('accepts %s', (url, tls, username, password, port, database) => {
    const settings = parseRedisSettings({ REDIS_URL: url })!;
    expect(settings.endpoint()).toEqual({ host: HOST, port, tls, username, password, database });
    expect(settings.keyPrefix).toBe('sync');
    expect(settings.connectTimeoutMs).toBe(10_000);
    expect(settings.commandTimeoutMs).toBe(2000);
  });

  it('accepts an IPv6 literal host', () => {
    expect(parseRedisSettings({ REDIS_URL: 'redis://[::1]:6390' })!.endpoint().host).toBe('::1');
  });

  it('reads the prefix and both timeouts', () => {
    const settings = parseRedisSettings({
      REDIS_URL: `redis://${HOST}`,
      REDIS_KEY_PREFIX: 'tenant_a-1',
      REDIS_CONNECT_TIMEOUT_SECONDS: '120',
      REDIS_COMMAND_TIMEOUT_MS: '100',
    })!;
    expect(settings.keyPrefix).toBe('tenant_a-1');
    expect(settings.connectTimeoutMs).toBe(120_000);
    expect(settings.commandTimeoutMs).toBe(100);
  });

  const invalid: Array<[string, string, string]> = [
    ['REDIS_URL', '', 'REDIS_URL must not be empty'],
    ['REDIS_URL', `${USER}:${PASSWORD}@${HOST}`, 'REDIS_URL is not a valid'],
    ['REDIS_URL', `http://${USER}:${PASSWORD}@${HOST}:6390`, 'REDIS_URL is not a valid'],
    ['REDIS_URL', `redis://${USER}:${PASSWORD}@:6390`, 'REDIS_URL is not a valid'],
    ['REDIS_URL', `redis://${USER}:${PASSWORD}@${HOST}:6390/?tls=0`, 'query string'],
    ['REDIS_URL', `redis://${USER}:${PASSWORD}@${HOST}:6390#x`, 'query string'],
    ['REDIS_URL', `redis://${USER}:${PASSWORD}@${HOST}:0`, 'REDIS_URL port'],
    ['REDIS_URL', `redis://${USER}:${PASSWORD}@${HOST}:99999`, 'REDIS_URL is not a valid'],
    ['REDIS_URL', `redis://${USER}:${PASSWORD}@${HOST}:6390/16`, 'REDIS_URL database'],
    ['REDIS_URL', `redis://${USER}:${PASSWORD}@${HOST}:6390/01`, 'REDIS_URL database'],
    ['REDIS_URL', `redis://${USER}:${PASSWORD}@${HOST}:6390/a/b`, 'REDIS_URL database'],
    ['REDIS_URL', `redis://${USER}:%E0%A4%A@${HOST}`, 'REDIS_URL is not a valid'],
    ['REDIS_KEY_PREFIX', '', 'REDIS_KEY_PREFIX must be'],
    ['REDIS_KEY_PREFIX', 'Sync', 'REDIS_KEY_PREFIX must be'],
    ['REDIS_KEY_PREFIX', 'a:b', 'REDIS_KEY_PREFIX must be'],
    ['REDIS_KEY_PREFIX', '-sync', 'REDIS_KEY_PREFIX must be'],
    ['REDIS_KEY_PREFIX', 'a'.repeat(33), 'REDIS_KEY_PREFIX must be'],
    ['REDIS_CONNECT_TIMEOUT_SECONDS', '0', 'REDIS_CONNECT_TIMEOUT_SECONDS must be'],
    ['REDIS_CONNECT_TIMEOUT_SECONDS', '121', 'REDIS_CONNECT_TIMEOUT_SECONDS must be'],
    ['REDIS_CONNECT_TIMEOUT_SECONDS', '1.5', 'REDIS_CONNECT_TIMEOUT_SECONDS must be'],
    ['REDIS_COMMAND_TIMEOUT_MS', '99', 'REDIS_COMMAND_TIMEOUT_MS must be'],
    ['REDIS_COMMAND_TIMEOUT_MS', '30001', 'REDIS_COMMAND_TIMEOUT_MS must be'],
    ['REDIS_COMMAND_TIMEOUT_MS', 'abc', 'REDIS_COMMAND_TIMEOUT_MS must be'],
  ];

  it.each(invalid)('reports %s=%j with the other config errors', (name, value, expected) => {
    const message = errorOf({ [name]: value, PORT: 'x' });
    expect(message).toContain(expected);
    expect(message).toContain('PORT must be a positive integer');
    expect(message.split('\n')).toHaveLength(2);
    expectNoUrlParts(message);
  });

  it('checks the prefix and timeouts even without REDIS_URL', () => {
    expect(errorOf({ REDIS_KEY_PREFIX: 'BAD' })).toContain('REDIS_KEY_PREFIX');
    expect(errorOf({ REDIS_COMMAND_TIMEOUT_MS: '5' })).toContain('REDIS_COMMAND_TIMEOUT_MS');
  });

  it('refuses the public dev password outside development and test (security C5)', () => {
    const url = `redis://:${DEV_REDIS_PASSWORD}@${HOST}`;
    for (const nodeEnv of [undefined, 'production', 'staging', 'Development']) {
      const message = errorOf({ REDIS_URL: url, ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}) });
      expect(message).toContain('public development Redis password');
      expect(message).not.toContain(DEV_REDIS_PASSWORD);
      expectNoUrlParts(message);
    }
    for (const nodeEnv of ['development', 'test']) {
      expect(parseRedisSettings({ REDIS_URL: url, NODE_ENV: nodeEnv })?.hasPassword).toBe(true);
    }
  });

  it('never shows the endpoint in JSON, string or inspect output (security C9)', () => {
    const settings = parseRedisSettings({
      REDIS_URL: `redis://${USER}:${PASSWORD}@${HOST}:6390/3`,
    })!;
    for (const text of [
      JSON.stringify(settings),
      JSON.stringify({ settings }),
      String(settings),
      inspect(settings, { showHidden: true, depth: 5 }),
      inspect({ settings }),
    ]) {
      expectNoUrlParts(text);
    }
    expect(settings.hasPassword).toBe(true);
  });
});

describe('REDIS_URL_FILE (#58 AC1, AC2, AC3, AC7)', () => {
  const files = secretFileDir('sync-redis-file-');
  afterAll(() => files.cleanup());
  let count = 0;
  const urlFile = (content: string): string => {
    count += 1;
    return files.file(`redis-url-${count}`, content);
  };
  const LABEL = 'REDIS_URL (from REDIS_URL_FILE)';

  it('reads the whole URL from the file, one trailing newline removed', () => {
    for (const content of [
      `redis://${USER}:${PASSWORD}@${HOST}:6390/2`,
      `redis://${USER}:${PASSWORD}@${HOST}:6390/2\n`,
      `redis://${USER}:${PASSWORD}@${HOST}:6390/2\r\n`,
    ]) {
      const settings = parseRedisSettings({ REDIS_URL_FILE: urlFile(content) })!;
      expect(settings.endpoint()).toEqual({
        host: HOST,
        port: 6390,
        tls: false,
        username: USER,
        password: PASSWORD,
        database: 2,
      });
      for (const text of [JSON.stringify(settings), String(settings), inspect(settings)]) {
        expectNoUrlParts(text);
        expectNoSentinel(text, PASSWORD);
      }
    }
  });

  it('keeps the URL parser lenient about surrounding whitespace, like the env (Gate 2)', () => {
    const viaFile = parseRedisSettings({ REDIS_URL_FILE: urlFile(` redis://${HOST}\r\n\n`) });
    const viaEnv = parseRedisSettings({ REDIS_URL: ` redis://${HOST}\r\n` });
    expect(viaFile?.endpoint()).toEqual(viaEnv?.endpoint());
  });

  const invalid: Array<[string, string]> = [
    [`${USER}:${PASSWORD}@${HOST}`, `${LABEL} is not a valid redis:// or rediss:// URL`],
    [
      `http://${USER}:${PASSWORD}@${HOST}:6390`,
      `${LABEL} is not a valid redis:// or rediss:// URL`,
    ],
    [
      `redis://${USER}:${PASSWORD}@${HOST}:6390/?tls=0`,
      `${LABEL} must not have a query string or fragment`,
    ],
    [
      `redis://${USER}:${PASSWORD}@${HOST}:6390#x`,
      `${LABEL} must not have a query string or fragment`,
    ],
    [`redis://${USER}:${PASSWORD}@${HOST}:0`, `${LABEL} port must be between 1 and 65535`],
    [
      `redis://${USER}:${PASSWORD}@${HOST}:6390/16`,
      `${LABEL} database must be a number from 0 to 15`,
    ],
    [`redis://${USER}:%E0%A4%A@${HOST}`, `${LABEL} is not a valid redis:// or rediss:// URL`],
  ];

  it.each(invalid)(
    'refuses %j from a file with the same rule and the file label',
    (url, expected) => {
      const message = errorOf({ REDIS_URL_FILE: urlFile(`${url}\n`), PORT: 'x' });
      expect(message.split('\n')).toEqual(['PORT must be a positive integer', expected]);
      expectNoUrlParts(message);
    },
  );

  it('refuses the public dev password from a file outside development and test', () => {
    const path = urlFile(`redis://:${DEV_REDIS_PASSWORD}@${HOST}\n`);
    expect(errorOf({ REDIS_URL_FILE: path, NODE_ENV: 'production' })).toBe(
      `${LABEL} uses the public development Redis password; it is only accepted when NODE_ENV is development or test`,
    );
    expect(parseRedisSettings({ REDIS_URL_FILE: path, NODE_ENV: 'test' })?.hasPassword).toBe(true);
  });

  it('keeps the env messages byte-identical (AC13)', () => {
    expect(errorOf({ REDIS_URL: `http://${HOST}` })).toBe(
      'REDIS_URL is not a valid redis:// or rediss:// URL',
    );
  });

  it('a both-set conflict or a bad file is a problem, never the memory store (C3)', () => {
    const good = urlFile(`redis://${HOST}`);
    for (const [env, expected] of [
      [
        { REDIS_URL: `redis://${HOST}`, REDIS_URL_FILE: good },
        'REDIS_URL and REDIS_URL_FILE are both set; set only one',
      ],
      [
        { REDIS_URL: '', REDIS_URL_FILE: good },
        'REDIS_URL and REDIS_URL_FILE are both set; set only one',
      ],
      [
        { REDIS_URL: `redis://${HOST}`, REDIS_URL_FILE: '' },
        'REDIS_URL and REDIS_URL_FILE are both set; set only one',
      ],
      [{ REDIS_URL_FILE: '' }, 'REDIS_URL_FILE must not be empty'],
      [{ REDIS_URL_FILE: join(files.dir, 'missing') }, 'REDIS_URL_FILE file does not exist'],
      [
        { REDIS_URL_FILE: urlFile('\n') },
        SECRET_FILE_MESSAGES.empty('REDIS_URL_FILE', join(files.dir, `redis-url-${count}`)),
      ],
    ] as Array<[Record<string, string>, string]>) {
      for (const nodeEnv of ['development', 'test', 'production']) {
        expect(errorOf({ ...env, NODE_ENV: nodeEnv })).toBe(expected);
        expect(() => parseRedisSettings({ ...env, NODE_ENV: nodeEnv })).toThrow(ConfigError);
      }
    }
  });

  it('never echoes a URL pasted into REDIS_URL_FILE by mistake (Q6 narrowing, C9)', () => {
    const message = errorOf({ REDIS_URL_FILE: `redis://${USER}:${PASSWORD}@${HOST}:6390/2` });
    expect(message.startsWith('REDIS_URL_FILE file ')).toBe(true);
    expectNoUrlParts(message);
    expectNoSentinel(message, PASSWORD);
  });
});
