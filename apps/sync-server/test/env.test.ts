import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config/config-error.js';
import { parseEnv } from '../src/config/env.js';

const NUMERIC = [
  'PORT',
  'MAX_GROUP_SIZE_CEILING',
  'MAX_LEADER_UPDATE_RATE_CEILING',
  'MAX_MESSAGE_SIZE_CEILING',
  'MAX_APP_CONNECTIONS_CEILING',
  'MAX_CONNECTIONS',
  'MAX_PENDING_HANDSHAKES',
  'MAX_INBOUND_MESSAGES_PER_SECOND',
  'MAX_INBOUND_BURST',
  'MAX_BUFFERED_BYTES',
];

function errorOf(env: Record<string, string>): ConfigError {
  try {
    parseEnv(env);
  } catch (err) {
    if (err instanceof ConfigError) return err;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('parseEnv', () => {
  it('applies the documented defaults when nothing is set', () => {
    expect(parseEnv({})).toEqual({
      configPath: './config/apps.json',
      port: 8080,
      host: '0.0.0.0',
      logLevel: 'info',
      nodeEnv: undefined,
      maxGroupSizeCeiling: 100,
      maxLeaderUpdateRateCeiling: 10,
      maxMessageSizeCeiling: 16384,
      maxAppConnectionsCeiling: 10000,
      maxConnections: 10000,
      maxPendingHandshakes: 1000,
      maxInboundMessagesPerSecond: 20,
      maxInboundBurst: 40,
      maxBufferedBytes: 1048576,
    });
  });

  it('reads every variable', () => {
    const env = parseEnv({
      SYNC_CONFIG_PATH: '/config/apps.json',
      PORT: '9000',
      HOST: '127.0.0.1',
      LOG_LEVEL: 'trace',
      NODE_ENV: 'production',
      MAX_GROUP_SIZE_CEILING: '50',
      MAX_LEADER_UPDATE_RATE_CEILING: '8',
      MAX_MESSAGE_SIZE_CEILING: '8192',
      MAX_APP_CONNECTIONS_CEILING: '500',
      MAX_CONNECTIONS: '2000',
      MAX_PENDING_HANDSHAKES: '100',
      MAX_INBOUND_MESSAGES_PER_SECOND: '9',
      MAX_INBOUND_BURST: '9',
      MAX_BUFFERED_BYTES: '32768',
    });
    expect(env).toMatchObject({
      configPath: '/config/apps.json',
      port: 9000,
      host: '127.0.0.1',
      logLevel: 'trace',
      nodeEnv: 'production',
      maxGroupSizeCeiling: 50,
      maxLeaderUpdateRateCeiling: 8,
      maxMessageSizeCeiling: 8192,
      maxAppConnectionsCeiling: 500,
      maxConnections: 2000,
      maxPendingHandshakes: 100,
      maxInboundMessagesPerSecond: 9,
      maxInboundBurst: 9,
      maxBufferedBytes: 32768,
    });
  });

  for (const name of NUMERIC) {
    for (const bad of ['0', '-1', 'abc', '1.5', '', ' 5', '1e3', '0x10', '05']) {
      it(`rejects ${name}=${JSON.stringify(bad)} naming the variable (AC6)`, () => {
        const err = errorOf({ [name]: bad });
        expect(err.message).toContain(name);
        if (bad !== '') expect(err.message).not.toContain(`"${bad}"`);
      });
    }
  }

  it('rejects a port above 65535', () => {
    expect(errorOf({ PORT: '65536' }).message).toContain('PORT');
  });

  it('rejects an unknown log level and empty paths', () => {
    expect(errorOf({ LOG_LEVEL: 'verbose' }).message).toContain('LOG_LEVEL');
    expect(errorOf({ SYNC_CONFIG_PATH: '' }).message).toContain('SYNC_CONFIG_PATH');
    expect(errorOf({ HOST: '' }).message).toContain('HOST');
  });

  it('reports every invalid variable at once', () => {
    const err = errorOf({ PORT: 'x', MAX_CONNECTIONS: '0' });
    expect(err.message).toContain('PORT');
    expect(err.message).toContain('MAX_CONNECTIONS');
  });

  describe('cross-field rules (H1, H2, H3, M5)', () => {
    it('MAX_PENDING_HANDSHAKES <= MAX_CONNECTIONS', () => {
      const err = errorOf({
        MAX_CONNECTIONS: '1000',
        MAX_APP_CONNECTIONS_CEILING: '1000',
        MAX_PENDING_HANDSHAKES: '2000',
      });
      expect(err.message).toBe('MAX_PENDING_HANDSHAKES (2000) must be <= MAX_CONNECTIONS (1000)');
      expect(() =>
        parseEnv({
          MAX_CONNECTIONS: '1000',
          MAX_APP_CONNECTIONS_CEILING: '1000',
          MAX_PENDING_HANDSHAKES: '1000',
        }),
      ).not.toThrow();
    });

    it('MAX_APP_CONNECTIONS_CEILING <= MAX_CONNECTIONS', () => {
      const err = errorOf({ MAX_CONNECTIONS: '5000', MAX_PENDING_HANDSHAKES: '10' });
      expect(err.message).toContain('MAX_APP_CONNECTIONS_CEILING');
      expect(err.message).toContain('MAX_CONNECTIONS');
    });

    it('MAX_INBOUND_MESSAGES_PER_SECOND > MAX_LEADER_UPDATE_RATE_CEILING', () => {
      const err = errorOf({ MAX_INBOUND_MESSAGES_PER_SECOND: '10' });
      expect(err.message).toContain('MAX_INBOUND_MESSAGES_PER_SECOND');
      expect(err.message).toContain('MAX_LEADER_UPDATE_RATE_CEILING');
    });

    it('MAX_INBOUND_BURST >= MAX_INBOUND_MESSAGES_PER_SECOND', () => {
      const err = errorOf({ MAX_INBOUND_BURST: '19' });
      expect(err.message).toContain('MAX_INBOUND_BURST');
      expect(err.message).toContain('MAX_INBOUND_MESSAGES_PER_SECOND');
      expect(() => parseEnv({ MAX_INBOUND_BURST: '20' })).not.toThrow();
    });

    it('MAX_BUFFERED_BYTES >= 4 * MAX_MESSAGE_SIZE_CEILING', () => {
      const err = errorOf({ MAX_BUFFERED_BYTES: '65535' });
      expect(err.message).toContain('MAX_BUFFERED_BYTES');
      expect(err.message).toContain('MAX_MESSAGE_SIZE_CEILING');
      expect(() => parseEnv({ MAX_BUFFERED_BYTES: '65536' })).not.toThrow();
    });
  });
});
