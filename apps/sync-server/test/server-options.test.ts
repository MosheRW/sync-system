import { randomBytes } from 'node:crypto';
import type * as Http from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRegistry } from '../src/apps/app-registry.js';
import { parseAppsConfig } from '../src/config/apps-config.js';
import { ConfigError } from '../src/config/config-error.js';
import { parseEnv } from '../src/config/env.js';
import type { TokenSecretsInput } from '../src/config/token-secret.js';
import { createLogger } from '../src/logging/logger.js';
import { type SyncServerOptions, createSyncServer } from '../src/server.js';
import { LogCapture } from './helpers/log-capture.js';
import { KEY_A } from './helpers/test-server.js';

// Count every HTTP server created, so a refused config provably binds nothing.
const created = vi.hoisted(() => ({ http: 0 }));
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof Http>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      created.http += 1;
      return actual.createServer(...args);
    },
  };
});

/** A recognisable secret value that must never appear in an error text. */
const SENTINEL = 'SENTINEL-short-secret';

function baseOptions(): Omit<SyncServerOptions, 'tokenSecrets'> {
  const env = parseEnv({ LOG_LEVEL: 'silent' });
  const registry = new AppRegistry(
    parseAppsConfig(
      JSON.stringify({ apps: [{ namespace: 'app-a', apiKey: KEY_A, minAppVersion: '1.0.0' }] }),
      env,
    ),
  );
  return {
    env,
    registry,
    logger: createLogger({ level: 'silent', destination: new LogCapture() }),
  };
}

/** Calls createSyncServer as untyped JS would, with any `tokenSecrets` value. */
function createUntyped(tokenSecrets: unknown, omit = false) {
  const options = omit ? baseOptions() : { ...baseOptions(), tokenSecrets };
  return () => createSyncServer(options as SyncServerOptions);
}

function expectConfigError(run: () => unknown): ConfigError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  const error = caught as ConfigError;
  expect(error.message).toContain('tokenSecrets');
  expect(error.message).not.toContain(SENTINEL);
  return error;
}

describe('createSyncServer token secrets (#7 L1)', () => {
  beforeEach(() => {
    created.http = 0;
  });

  it('is a required option at compile time (AC1)', () => {
    // @ts-expect-error tokenSecrets is required
    const run = () => createSyncServer(baseOptions());
    expectConfigError(run);
  });

  it.each([
    ['omitted', undefined, true],
    ['undefined', undefined, false],
    ['null', null, false],
    ['an empty object', {}, false],
    ['a string current', { current: `${SENTINEL}-0123456789-0123456789`, source: 'env' }, false],
    ['a short current', { current: Buffer.from(SENTINEL), source: 'env' }, false],
    [
      'a string previous',
      { current: randomBytes(32), previous: `${SENTINEL}-0123456789-0123456789`, source: 'env' },
      false,
    ],
    [
      'a short previous',
      { current: randomBytes(32), previous: Buffer.from(SENTINEL), source: 'env' },
      false,
    ],
  ])('throws a ConfigError and binds nothing when tokenSecrets is %s (AC2)', (_l, value, omit) => {
    expectConfigError(createUntyped(value, omit));
    expect(created.http).toBe(0);
  });

  it('starts with a 32-byte current and an optional 32-byte previous', async () => {
    const secrets: TokenSecretsInput = {
      current: randomBytes(32),
      previous: randomBytes(32),
      source: 'env',
    };
    const server = createSyncServer({ ...baseOptions(), tokenSecrets: secrets });
    expect(created.http).toBe(1);
    await server.close();
  });
});
