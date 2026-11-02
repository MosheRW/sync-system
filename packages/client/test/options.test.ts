import { describe, expect, it } from 'vitest';
import { isSyncClientError } from '../src/errors.js';
import { resolveOptions } from '../src/options.js';

const BASE = { url: 'wss://sync.example.com/ws', apiKey: 'k'.repeat(40), appVersion: '1.0.0' };

function fieldOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (isSyncClientError(err, 'INVALID_OPTIONS')) return err.details.field;
    throw err;
  }
  return undefined;
}

describe('resolveOptions', () => {
  it('applies the defaults (Q3)', () => {
    const resolved = resolveOptions(BASE);
    expect(resolved).toMatchObject({
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      maxAttempts: Number.POSITIVE_INFINITY,
      stableAfterMs: 10_000,
      requestTimeoutMs: 10_000,
      allowInsecureTransport: false,
      WebSocket: undefined,
      logger: undefined,
      random: undefined,
      storage: 'local',
    });
  });

  it('accepts the storage option and records the server host (#5 AC32, AC33)', () => {
    const custom = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    expect(resolveOptions({ ...BASE, storage: 'memory' }).storage).toBe('memory');
    expect(resolveOptions({ ...BASE, storage: custom }).storage).toBe(custom);
    for (const storage of ['session', 42, {}, { getItem() {}, setItem() {} }, null]) {
      expect(fieldOf(() => resolveOptions({ ...BASE, storage }))).toBe('storage');
    }
    expect(resolveOptions({ ...BASE, url: 'wss://sync.example.com/ws' }).storageHost).toBe(
      'sync.example.com',
    );
    expect(resolveOptions({ ...BASE, url: 'wss://sync.example.com:443/ws' }).storageHost).toBe(
      'sync.example.com',
    );
    expect(resolveOptions({ ...BASE, url: 'ws://localhost:8080/ws' }).storageHost).toBe(
      'localhost:8080',
    );
  });

  it('keeps no reference to the options object (L4)', () => {
    const reconnect = { maxAttempts: 3 };
    const options = { ...BASE, reconnect };
    const resolved = resolveOptions(options);
    expect(resolved).not.toBe(options);
    expect(Object.values(resolved)).not.toContain(reconnect);
    reconnect.maxAttempts = 99;
    expect(resolved.maxAttempts).toBe(3);
  });

  it('rejects a non-object', () => {
    expect(fieldOf(() => resolveOptions(undefined))).toBe('options');
    expect(fieldOf(() => resolveOptions('wss://x'))).toBe('options');
  });

  it('checks apiKey and appVersion lengths', () => {
    expect(fieldOf(() => resolveOptions({ ...BASE, apiKey: '' }))).toBe('apiKey');
    expect(fieldOf(() => resolveOptions({ ...BASE, apiKey: 'k'.repeat(257) }))).toBe('apiKey');
    expect(fieldOf(() => resolveOptions({ ...BASE, apiKey: 42 }))).toBe('apiKey');
    expect(fieldOf(() => resolveOptions({ ...BASE, appVersion: '' }))).toBe('appVersion');
    expect(fieldOf(() => resolveOptions({ ...BASE, appVersion: 'v'.repeat(257) }))).toBe(
      'appVersion',
    );
  });

  it('never echoes values in the error', () => {
    try {
      resolveOptions({ ...BASE, apiKey: 'SECRET-'.repeat(50) });
    } catch (err) {
      expect(JSON.stringify(err)).not.toContain('SECRET');
      expect(String(err)).not.toContain('SECRET');
    }
  });

  it('rejects Infinity, NaN, negative and too large *Ms values (M1)', () => {
    const cases: Array<[string, Record<string, unknown>]> = [];
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, -1, 2 ** 31, '500']) {
      cases.push(['reconnect.initialDelayMs', { reconnect: { initialDelayMs: bad } }]);
      cases.push(['reconnect.maxDelayMs', { reconnect: { maxDelayMs: bad } }]);
      cases.push(['reconnect.stableAfterMs', { reconnect: { stableAfterMs: bad } }]);
      cases.push(['requestTimeoutMs', { requestTimeoutMs: bad }]);
    }
    for (const [field, extra] of cases) {
      expect(
        fieldOf(() => resolveOptions({ ...BASE, ...extra })),
        field,
      ).toBe(field);
    }
  });

  it('enforces the minimum values that keep H1 and M3 on (R2-L1)', () => {
    expect(fieldOf(() => resolveOptions({ ...BASE, reconnect: { initialDelayMs: 99 } }))).toBe(
      'reconnect.initialDelayMs',
    );
    expect(fieldOf(() => resolveOptions({ ...BASE, reconnect: { maxDelayMs: 999 } }))).toBe(
      'reconnect.maxDelayMs',
    );
    expect(fieldOf(() => resolveOptions({ ...BASE, reconnect: { stableAfterMs: 0 } }))).toBe(
      'reconnect.stableAfterMs',
    );
    expect(fieldOf(() => resolveOptions({ ...BASE, reconnect: { stableAfterMs: 999 } }))).toBe(
      'reconnect.stableAfterMs',
    );
    const floors = resolveOptions({
      ...BASE,
      reconnect: { initialDelayMs: 100, maxDelayMs: 1000, stableAfterMs: 1000 },
    });
    expect(floors).toMatchObject({ initialDelayMs: 100, maxDelayMs: 1000, stableAfterMs: 1000 });
  });

  it('requires maxDelayMs >= initialDelayMs and 2 x requestTimeoutMs to fit a timer', () => {
    expect(
      fieldOf(() =>
        resolveOptions({ ...BASE, reconnect: { initialDelayMs: 5000, maxDelayMs: 2000 } }),
      ),
    ).toBe('reconnect.maxDelayMs');
    expect(fieldOf(() => resolveOptions({ ...BASE, requestTimeoutMs: 0 }))).toBe(
      'requestTimeoutMs',
    );
    expect(fieldOf(() => resolveOptions({ ...BASE, requestTimeoutMs: 2 ** 30 }))).toBe(
      'requestTimeoutMs',
    );
    expect(resolveOptions({ ...BASE, reconnect: { initialDelayMs: 20_000 } }).maxDelayMs).toBe(
      20_000,
    );
  });

  it('accepts maxAttempts Infinity or a positive integer only', () => {
    expect(
      resolveOptions({ ...BASE, reconnect: { maxAttempts: Number.POSITIVE_INFINITY } }).maxAttempts,
    ).toBe(Number.POSITIVE_INFINITY);
    expect(resolveOptions({ ...BASE, reconnect: { maxAttempts: 3 } }).maxAttempts).toBe(3);
    for (const bad of [0, -1, 1.5, Number.NaN, '3']) {
      expect(fieldOf(() => resolveOptions({ ...BASE, reconnect: { maxAttempts: bad } }))).toBe(
        'reconnect.maxAttempts',
      );
    }
  });

  it('checks the types of the other options', () => {
    expect(fieldOf(() => resolveOptions({ ...BASE, allowInsecureTransport: 'true' }))).toBe(
      'allowInsecureTransport',
    );
    expect(fieldOf(() => resolveOptions({ ...BASE, random: 0.5 }))).toBe('random');
    expect(fieldOf(() => resolveOptions({ ...BASE, logger: 'console' }))).toBe('logger');
    expect(fieldOf(() => resolveOptions({ ...BASE, WebSocket: {} }))).toBe('WebSocket');
    expect(fieldOf(() => resolveOptions({ ...BASE, reconnect: 5 }))).toBe('reconnect');
    expect(fieldOf(() => resolveOptions({ ...BASE, url: 5 }))).toBe('url');
    expect(resolveOptions({ ...BASE, allowInsecureTransport: true }).allowInsecureTransport).toBe(
      true,
    );
  });
});
