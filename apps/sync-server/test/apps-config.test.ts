import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppRegistry, hashApiKey } from '../src/apps/app-registry.js';
import { ConfigError } from '../src/config/config-error.js';
import { loadAppsConfigFile, parseAppsConfig } from '../src/config/apps-config.js';
import { parseEnv } from '../src/config/env.js';

const env = parseEnv({});
const KEY_A = 'key-a-0123456789-0123456789-0123456789';
const KEY_B = 'key-b-0123456789-0123456789-0123456789';
const SECRET_KEY = 'SENTINEL-KEY-do-not-print-0123456789abcdef';

function app(overrides: Record<string, unknown> = {}) {
  return { namespace: 'reading-app', apiKey: KEY_A, minAppVersion: '1.0.0', ...overrides };
}

function config(...apps: unknown[]): string {
  return JSON.stringify({ apps });
}

function errorOf(text: string, ceilings = env): ConfigError {
  try {
    parseAppsConfig(text, ceilings, 'apps.json');
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('parseAppsConfig', () => {
  it('loads every field of a valid app (AC4)', () => {
    const [loaded] = parseAppsConfig(
      config(
        app({
          maxGroupSize: 20,
          maxLeaderUpdatesPerSecond: 3,
          maxMessageBytes: 2048,
          maxConnections: 50,
          maxSessionMinutes: 120,
          inactivityLimitMinutes: 10,
          joinMethods: ['D', 'B'],
          qrTicketSeconds: 600,
          approvalTimeoutSeconds: 60,
        }),
      ),
      env,
    );
    expect(loaded).toEqual({
      namespace: 'reading-app',
      apiKeyHash: hashApiKey(KEY_A),
      minAppVersion: '1.0.0',
      maxGroupSize: 20,
      maxLeaderUpdatesPerSecond: 3,
      maxMessageBytes: 2048,
      maxConnections: 50,
      maxSessionMinutes: 120,
      inactivityLimitMinutes: 10,
      joinMethods: ['B', 'D'],
      qrTicketSeconds: 600,
      approvalTimeoutSeconds: 60,
    });
    expect(JSON.stringify(loaded)).not.toContain(KEY_A);
  });

  it('applies defaults when optional fields are omitted (AC4)', () => {
    const [loaded] = parseAppsConfig(config(app()), env);
    expect(loaded).toMatchObject({
      maxGroupSize: 30,
      maxLeaderUpdatesPerSecond: 5,
      maxMessageBytes: 4096,
      maxConnections: 1000,
      maxSessionMinutes: 180,
      inactivityLimitMinutes: 20,
      joinMethods: ['A', 'D'],
      qrTicketSeconds: 300,
      approvalTimeoutSeconds: 120,
    });
  });

  it('accepts a file that starts with a byte order mark', () => {
    const text = String.fromCharCode(0xfeff) + config(app());
    expect(parseAppsConfig(text, env)).toHaveLength(1);
  });

  it('uses min(default, ceiling) when a ceiling is below a default (AC5)', () => {
    const low = parseEnv({
      MAX_GROUP_SIZE_CEILING: '10',
      MAX_LEADER_UPDATE_RATE_CEILING: '2',
      MAX_MESSAGE_SIZE_CEILING: '1024',
      MAX_APP_CONNECTIONS_CEILING: '100',
      MAX_BUFFERED_BYTES: '65536',
      MAX_SESSION_MINUTES_CEILING: '90',
      INACTIVITY_LIMIT_MINUTES_CEILING: '5',
      QR_TICKET_SECONDS_CEILING: '60',
      APPROVAL_TIMEOUT_SECONDS_CEILING: '20',
    });
    const [loaded] = parseAppsConfig(config(app()), low);
    expect(loaded).toMatchObject({
      maxGroupSize: 10,
      maxLeaderUpdatesPerSecond: 2,
      maxMessageBytes: 1024,
      maxConnections: 100,
      maxSessionMinutes: 90,
      inactivityLimitMinutes: 5,
      qrTicketSeconds: 60,
      approvalTimeoutSeconds: 20,
    });
  });

  const ceilingCases = [
    ['maxGroupSize', 100, 'MAX_GROUP_SIZE_CEILING'],
    ['maxLeaderUpdatesPerSecond', 10, 'MAX_LEADER_UPDATE_RATE_CEILING'],
    ['maxMessageBytes', 16384, 'MAX_MESSAGE_SIZE_CEILING'],
    ['maxConnections', 10000, 'MAX_APP_CONNECTIONS_CEILING'],
    ['maxSessionMinutes', 480, 'MAX_SESSION_MINUTES_CEILING'],
    ['inactivityLimitMinutes', 60, 'INACTIVITY_LIMIT_MINUTES_CEILING'],
    ['qrTicketSeconds', 3600, 'QR_TICKET_SECONDS_CEILING'],
    ['approvalTimeoutSeconds', 600, 'APPROVAL_TIMEOUT_SECONDS_CEILING'],
  ] as const;

  for (const [field, ceiling, ceilingName] of ceilingCases) {
    it(`rejects ${field} above ${ceilingName} and accepts it at the ceiling (AC5)`, () => {
      const err = errorOf(config(app({ [field]: ceiling + 1 })));
      expect(err.message).toBe(
        `apps.json: apps[0] (namespace "reading-app"): ${field} ${ceiling + 1} exceeds ${ceilingName} ${ceiling}`,
      );
      const [loaded] = parseAppsConfig(config(app({ [field]: ceiling })), env);
      expect(loaded?.[field]).toBe(ceiling);
    });
  }

  it('rejects non-positive and fractional limits', () => {
    expect(errorOf(config(app({ maxGroupSize: 1 }))).message).toContain('maxGroupSize');
    expect(errorOf(config(app({ maxMessageBytes: 0 }))).message).toContain('maxMessageBytes');
    expect(errorOf(config(app({ maxConnections: -1 }))).message).toContain('maxConnections');
    expect(errorOf(config(app({ maxLeaderUpdatesPerSecond: 1.5 }))).message).toContain(
      'maxLeaderUpdatesPerSecond',
    );
  });

  it('enforces the join timer minimums (#10 AC3)', () => {
    expect(errorOf(config(app({ qrTicketSeconds: 29 }))).message).toBe(
      'apps.json: apps[0] (namespace "reading-app"): qrTicketSeconds must be an integer >= 30',
    );
    expect(errorOf(config(app({ approvalTimeoutSeconds: 14 }))).message).toBe(
      'apps.json: apps[0] (namespace "reading-app"): approvalTimeoutSeconds must be an integer >= 15',
    );
    const [loaded] = parseAppsConfig(
      config(app({ qrTicketSeconds: 30, approvalTimeoutSeconds: 15 })),
      env,
    );
    expect(loaded).toMatchObject({ qrTicketSeconds: 30, approvalTimeoutSeconds: 15 });
  });

  describe('joinMethods (#10 AC2)', () => {
    it('defaults to A and D intersected with JOIN_METHODS_ALLOWED', () => {
      const onlyD = parseEnv({ JOIN_METHODS_ALLOWED: 'C,D' });
      expect(parseAppsConfig(config(app()), onlyD)[0]?.joinMethods).toEqual(['D']);
      const all = parseAppsConfig(config(app()), env)[0];
      expect(all?.joinMethods).toEqual(['A', 'D']);
      expect(Object.isFrozen(all?.joinMethods)).toBe(true);
    });

    it('is required when the env allows neither A nor D', () => {
      const err = errorOf(config(app()), parseEnv({ JOIN_METHODS_ALLOWED: 'B,C' }));
      expect(err.message).toBe(
        'apps.json: apps[0] (namespace "reading-app"): joinMethods is required because JOIN_METHODS_ALLOWED does not include A or D',
      );
      const ok = parseAppsConfig(
        config(app({ joinMethods: ['C'] })),
        parseEnv({ JOIN_METHODS_ALLOWED: 'B,C' }),
      );
      expect(ok[0]?.joinMethods).toEqual(['C']);
    });

    it('rejects a method the env does not allow, naming the app, field and method', () => {
      const err = errorOf(
        config(app({ joinMethods: ['A', 'C'] })),
        parseEnv({ JOIN_METHODS_ALLOWED: 'A,D' }),
      );
      expect(err.message).toBe(
        'apps.json: apps[0] (namespace "reading-app"): joinMethods "C" is not in JOIN_METHODS_ALLOWED',
      );
    });

    it.each([[[]], [['A', 'A']], [['E']], [['a']], ['A'], [[1]], [['A', 'B', 'C', 'D', 'A']]])(
      'rejects joinMethods %j',
      (joinMethods) => {
        const err = errorOf(config(app({ joinMethods })));
        expect(err.message).toContain(
          'apps[0] (namespace "reading-app"): joinMethods must be a non-empty array of distinct methods "A", "B", "C", "D"',
        );
      },
    );

    it('keeps the canonical order', () => {
      const [loaded] = parseAppsConfig(config(app({ joinMethods: ['D', 'C', 'A', 'B'] })), env);
      expect(loaded?.joinMethods).toEqual(['A', 'B', 'C', 'D']);
    });

    it('parses the example and dev configs with joinMethods', () => {
      for (const name of ['apps.example.json', 'apps.dev.json']) {
        const text = readFileSync(new URL(`../../../config/${name}`, import.meta.url), 'utf8');
        const apps = parseAppsConfig(text, env);
        for (const loaded of apps) expect(loaded.joinMethods.length).toBeGreaterThan(0);
      }
    });
  });

  it('reports a missing required field (AC6)', () => {
    for (const field of ['namespace', 'apiKey', 'minAppVersion']) {
      const entry: Record<string, unknown> = app();
      delete entry[field];
      expect(errorOf(config(entry)).message).toContain(`${field} is required`);
    }
  });

  it('reports a wrong type (AC6)', () => {
    expect(errorOf(config(app({ maxGroupSize: '30' }))).message).toContain(
      'maxGroupSize must be an integer',
    );
    expect(errorOf(config(app({ apiKey: 12345 }))).message).toContain('apiKey must be');
    expect(errorOf(config(app({ namespace: 'Bad Name' }))).message).toContain('namespace must');
  });

  it('rejects unknown fields to catch typos', () => {
    expect(errorOf(config(app({ maxGroupsize: 10 }))).message).toContain(
      'unknown field(s): maxGroupsize',
    );
  });

  it('requires a non-empty apps array', () => {
    expect(errorOf('{}').message).toContain('"apps" must be a non-empty array');
    expect(errorOf('{"apps": []}').message).toContain('"apps" must be a non-empty array');
    expect(errorOf('[]').message).toContain('must be a JSON object');
    expect(errorOf('{"apps": [1]}').message).toContain('apps[0] must be an object');
  });

  it('reports a duplicate API key without printing it (AC6)', () => {
    const err = errorOf(
      config(app({ namespace: 'a', apiKey: SECRET_KEY }), app({ namespace: 'b', apiKey: KEY_B }), {
        ...app({ namespace: 'c', apiKey: SECRET_KEY }),
      }),
    );
    expect(err.message).toBe(
      'apps.json: apps[2] (namespace "c") has the same apiKey as apps[0] (namespace "a")',
    );
    expect(err.message).not.toContain(SECRET_KEY);
  });

  it('reports a duplicate namespace (AC6)', () => {
    const err = errorOf(config(app({ apiKey: KEY_A }), app({ apiKey: KEY_B })));
    expect(err.message).toContain('apps[1] has the same namespace "reading-app" as apps[0]');
  });

  it('requires keys of 32 to 256 characters (L7, L2)', () => {
    const k31 = 'k'.repeat(31);
    const err = errorOf(config(app({ apiKey: k31 })));
    expect(err.message).toContain('apiKey must be a string of 32-256 characters');
    expect(err.message).not.toContain(k31);
    expect(() => parseAppsConfig(config(app({ apiKey: 'k'.repeat(32) })), env)).not.toThrow();
    expect(() => parseAppsConfig(config(app({ apiKey: 'k'.repeat(256) })), env)).not.toThrow();
    expect(errorOf(config(app({ apiKey: 'k'.repeat(257) }))).message).toContain('apiKey');
  });

  it('requires minAppVersion to be valid semver (AC9)', () => {
    for (const bad of ['1.0', 'latest', '', '1.0.0.0', '1'.repeat(65)]) {
      expect(errorOf(config(app({ minAppVersion: bad }))).message).toContain('minAppVersion');
    }
    expect(() =>
      parseAppsConfig(config(app({ minAppVersion: '2.1.0-beta.1' })), env),
    ).not.toThrow();
  });

  it('never prints the API key in any error (AC6)', () => {
    const texts = [
      config(app({ apiKey: SECRET_KEY, maxGroupSize: 'x' })),
      config(app({ apiKey: SECRET_KEY, extra: true })),
      config(app({ apiKey: SECRET_KEY, minAppVersion: 'bad' })),
      config(app({ apiKey: SECRET_KEY, namespace: 7 })),
      config(app({ apiKey: SECRET_KEY + 'x'.repeat(300) })),
    ];
    for (const text of texts) {
      expect(errorOf(text).message).not.toContain('SENTINEL');
    }
  });

  describe('invalid JSON (M2)', () => {
    it('reports only the position for a syntax error right after a key value', () => {
      const text = `{\n  "apps": [\n    { "namespace": "a", "apiKey": "${SECRET_KEY}" x }\n  ]\n}`;
      const err = errorOf(text);
      expect(err.message).toMatch(/^apps\.json: not valid JSON \(line 3, column \d+\)$/);
      expect(err.message).not.toContain('SENTINEL');
    });

    it('never includes the input for any malformed text', () => {
      for (const text of [
        `{"apiKey": "${SECRET_KEY}"`,
        `${SECRET_KEY}`,
        `{"apps": ["${SECRET_KEY}" "${SECRET_KEY}"]}`,
        '',
      ]) {
        const err = errorOf(text);
        expect(err.message).toContain('not valid JSON');
        expect(err.message).not.toContain('SENTINEL');
      }
    });
  });
});

describe('loadAppsConfigFile', () => {
  it('loads a file and reports a missing file (AC4, AC6)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-apps-'));
    const path = join(dir, 'apps.json');
    writeFileSync(path, config(app()));
    expect(loadAppsConfigFile(path, env)).toHaveLength(1);
    expect(() => loadAppsConfigFile(join(dir, 'missing.json'), env)).toThrow(
      /missing\.json: config file not found/,
    );
  });
});

describe('AppRegistry', () => {
  it('finds apps by API key through the key hash', () => {
    const apps = parseAppsConfig(
      config(app({ namespace: 'a', apiKey: KEY_A }), app({ namespace: 'b', apiKey: KEY_B })),
      env,
    );
    const registry = new AppRegistry(apps);
    expect(registry.findByApiKey(KEY_A)?.namespace).toBe('a');
    expect(registry.findByApiKey(KEY_B)?.namespace).toBe('b');
    expect(registry.findByApiKey('unknown-key-0123456789-0123456789')).toBeUndefined();
    expect(Object.isFrozen(registry.findByApiKey(KEY_A))).toBe(true);
  });
});
