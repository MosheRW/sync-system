import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { AppRegistry } from '../src/apps/app-registry.js';
import { parseAppsConfig } from '../src/config/apps-config.js';
import { parseEnv } from '../src/config/env.js';
import { TokenSecrets, type TokenSecretsInput } from '../src/config/token-secret.js';
import { createLogger } from '../src/logging/logger.js';
import { createSyncServer } from '../src/server.js';
import { TokenKeyring, deriveAppKey } from '../src/tokens/token-keys.js';
import type * as TokenKeys from '../src/tokens/token-keys.js';
import { LogCapture } from './helpers/log-capture.js';
import { expectNoSentinel } from './helpers/secret-files.js';
import { KEY_A } from './helpers/test-server.js';

// Records the secrets every TokenKeyring is built with (#58 security C7).
const seen = vi.hoisted(() => ({ secrets: [] as unknown[] }));
vi.mock('../src/tokens/token-keys.js', async (importOriginal) => {
  const actual = await importOriginal<typeof TokenKeys>();
  class RecordingKeyring extends actual.TokenKeyring {
    constructor(...args: ConstructorParameters<typeof actual.TokenKeyring>) {
      super(...args);
      seen.secrets.push(args[0]);
    }
  }
  return { ...actual, TokenKeyring: RecordingKeyring };
});

/** Test-only values; never real. */
const SENTINEL = 'SENTINEL-caller-Qm7Zx2Lv9Kd4Rt8Wn3Hb6Jf1Pc0Ys5';
const SENTINEL_2 = 'SENTINEL-caller2-Hb6Jf1Pc0Ys5Qm7Zx2Lv9Kd4Rt8Wn';

describe('createSyncServer: caller-built token secrets (#58 security C7)', () => {
  it('keeps only an opaque handle and leaves the caller object as it was', async () => {
    const env = parseEnv({ LOG_LEVEL: 'silent' });
    const registry = new AppRegistry(
      parseAppsConfig(
        JSON.stringify({ apps: [{ namespace: 'app-a', apiKey: KEY_A, minAppVersion: '1.0.0' }] }),
        env,
      ),
    );
    const given: TokenSecretsInput = {
      current: Buffer.from(SENTINEL, 'utf8'),
      previous: Buffer.from(SENTINEL_2, 'utf8'),
      source: 'env',
    };
    const server = createSyncServer({
      env,
      registry,
      logger: createLogger({ level: 'silent', destination: new LogCapture() }),
      tokenSecrets: given,
    });
    try {
      expect(seen.secrets.length).toBeGreaterThanOrEqual(3);
      for (const secrets of [...seen.secrets]) {
        expect(secrets).not.toBe(given);
        expect(secrets).toBeInstanceOf(TokenSecrets);
        const held = secrets as TokenSecrets;
        expect(held.source).toBe('env');
        expect(held.hasPrevious).toBe(true);
        // No field or prototype member gives the bytes back out (Gate 3 round 3).
        expect(Object.getOwnPropertyNames(held)).toEqual(['source']);
        for (const value of [held, { ...held }, Object.values(held)] as unknown[]) {
          const text = [
            JSON.stringify(value),
            inspect(value, { depth: 10, showHidden: true }),
            String(value),
          ].join('\n');
          expectNoSentinel(text, SENTINEL);
          expectNoSentinel(text, SENTINEL_2);
        }
        // The handle still signs and verifies with the caller's bytes.
        const keys = new TokenKeyring(held).keysFor('app-a');
        expect(keys.current.equals(deriveAppKey(given.current, 'app-a'))).toBe(true);
        expect(keys.verify[1]!.equals(deriveAppKey(given.previous!, 'app-a'))).toBe(true);
      }
      expect(Object.isFrozen(given)).toBe(false);
      expect(given.current.toString('utf8')).toBe(SENTINEL);
    } finally {
      await server.close();
    }
  });
});
