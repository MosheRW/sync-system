import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config/config-error.js';
import { parseEnv } from '../src/config/env.js';
import {
  DEFAULT_GROUP_CREATES_PER_APP_PER_MINUTE,
  DEFAULT_GROUP_CREATES_PER_CONNECTION_PER_MINUTE,
  DEFAULT_GROUP_CREATE_BURST_PER_APP,
  DEFAULT_MAX_LIVE_GROUPS_PER_APP,
} from '../src/limits/constants.js';

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
  'MAX_SESSION_MINUTES_CEILING',
  'INACTIVITY_LIMIT_MINUTES_CEILING',
  'TOKEN_REFRESH_ACTIVITIES',
  'TOKEN_REFRESH_MIN_SECONDS',
  'TOKEN_REFRESH_MAX_SECONDS',
  'QR_TICKET_SECONDS_CEILING',
  'APPROVAL_TIMEOUT_SECONDS_CEILING',
  'MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE',
  'MAX_GROUP_CREATE_BURST_PER_APP',
  'MAX_GROUP_CREATES_PER_APP_PER_MINUTE',
  'MAX_LIVE_GROUPS_PER_APP',
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
      maxBufferedBytes: 262144,
      maxSessionMinutesCeiling: 480,
      inactivityLimitMinutesCeiling: 60,
      tokenRefreshActivities: 10,
      tokenRefreshMinSeconds: 60,
      tokenRefreshMaxSeconds: 300,
      joinMethodsAllowed: ['A', 'B', 'C', 'D'],
      qrTicketSecondsCeiling: 3600,
      approvalTimeoutSecondsCeiling: 600,
      disconnectGraceSecondsCeiling: 120,
      keepAliveCountdownSecondsCeiling: 120,
      maxGroupCreatesPerConnectionPerMinute: 6,
      maxGroupCreateBurstPerApp: 120,
      maxGroupCreatesPerAppPerMinute: 120,
      maxLiveGroupsPerApp: 10_000,
    });
  });

  describe('group creation limits (#12 Q-2)', () => {
    const LIMITS = [
      'MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE',
      'MAX_GROUP_CREATE_BURST_PER_APP',
      'MAX_GROUP_CREATES_PER_APP_PER_MINUTE',
      'MAX_LIVE_GROUPS_PER_APP',
    ] as const;

    it('defaults to the DEFAULT_* constants', () => {
      expect(parseEnv({})).toMatchObject({
        maxGroupCreatesPerConnectionPerMinute: DEFAULT_GROUP_CREATES_PER_CONNECTION_PER_MINUTE,
        maxGroupCreateBurstPerApp: DEFAULT_GROUP_CREATE_BURST_PER_APP,
        maxGroupCreatesPerAppPerMinute: DEFAULT_GROUP_CREATES_PER_APP_PER_MINUTE,
        maxLiveGroupsPerApp: DEFAULT_MAX_LIVE_GROUPS_PER_APP,
      });
    });

    it('reads set values', () => {
      expect(
        parseEnv({
          MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE: '2',
          MAX_GROUP_CREATE_BURST_PER_APP: '10',
          MAX_GROUP_CREATES_PER_APP_PER_MINUTE: '30',
          MAX_LIVE_GROUPS_PER_APP: '500',
        }),
      ).toMatchObject({
        maxGroupCreatesPerConnectionPerMinute: 2,
        maxGroupCreateBurstPerApp: 10,
        maxGroupCreatesPerAppPerMinute: 30,
        maxLiveGroupsPerApp: 500,
      });
    });

    it('rejects values that are not positive integers, without the raw value', () => {
      const tooBig = '9007199254740993';
      for (const name of LIMITS) {
        for (const bad of ['abc', '0', '-1', '1.5', '01', '', tooBig]) {
          const err = errorOf({ [name]: bad });
          expect(err.problems, `${name}=${bad}`).toEqual([`${name} must be a positive integer`]);
          if (bad.length > 1) expect(err.message).not.toContain(bad);
        }
      }
    });

    it('enforces the ranges and accepts their ends', () => {
      const cases: ReadonlyArray<readonly [string, string, string]> = [
        ['MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE', '601', 'between 1 and 600'],
        ['MAX_GROUP_CREATES_PER_APP_PER_MINUTE', '60001', 'between 1 and 60000'],
        ['MAX_LIVE_GROUPS_PER_APP', '2', 'between 3 and 100000'],
        ['MAX_LIVE_GROUPS_PER_APP', '100001', 'between 3 and 100000'],
      ];
      for (const [name, value, range] of cases) {
        expect(errorOf({ [name]: value }).problems).toEqual([`${name} must be ${range}`]);
      }
      expect(() =>
        parseEnv({
          MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE: '1',
          MAX_GROUP_CREATES_PER_APP_PER_MINUTE: '1',
          MAX_GROUP_CREATE_BURST_PER_APP: '1',
          MAX_LIVE_GROUPS_PER_APP: '3',
        }),
      ).not.toThrow();
      expect(() =>
        parseEnv({
          MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE: '600',
          MAX_GROUP_CREATES_PER_APP_PER_MINUTE: '60000',
          MAX_LIVE_GROUPS_PER_APP: '100000',
        }),
      ).not.toThrow();
    });

    it('requires MAX_LIVE_GROUPS_PER_APP > 2 * MAX_GROUP_CREATE_BURST_PER_APP (Q-2.2)', () => {
      expect(
        errorOf({ MAX_LIVE_GROUPS_PER_APP: '240', MAX_GROUP_CREATE_BURST_PER_APP: '120' }).problems,
      ).toEqual([
        'MAX_LIVE_GROUPS_PER_APP (240) must be > 2 * MAX_GROUP_CREATE_BURST_PER_APP (240)',
      ]);
      expect(() =>
        parseEnv({ MAX_LIVE_GROUPS_PER_APP: '241', MAX_GROUP_CREATE_BURST_PER_APP: '120' }),
      ).not.toThrow();
      expect(() =>
        parseEnv({ MAX_LIVE_GROUPS_PER_APP: '3', MAX_GROUP_CREATE_BURST_PER_APP: '1' }),
      ).not.toThrow();
      // The default burst (120) is more than half of a cap of 200.
      expect(errorOf({ MAX_LIVE_GROUPS_PER_APP: '200' }).problems).toEqual([
        'MAX_LIVE_GROUPS_PER_APP (200) must be > 2 * MAX_GROUP_CREATE_BURST_PER_APP (240)',
      ]);
    });

    it('skips the cross rule when either value is invalid on its own', () => {
      expect(
        errorOf({ MAX_LIVE_GROUPS_PER_APP: '2', MAX_GROUP_CREATE_BURST_PER_APP: '120' }).problems,
      ).toEqual(['MAX_LIVE_GROUPS_PER_APP must be between 3 and 100000']);
      expect(
        errorOf({ MAX_LIVE_GROUPS_PER_APP: '100', MAX_GROUP_CREATE_BURST_PER_APP: 'x' }).problems,
      ).toEqual(['MAX_GROUP_CREATE_BURST_PER_APP must be a positive integer']);
    });
  });

  it('reads the lifecycle timer ceilings within 1-3600 (#13 AC1)', () => {
    expect(
      parseEnv({
        DISCONNECT_GRACE_SECONDS_CEILING: '60',
        KEEP_ALIVE_COUNTDOWN_SECONDS_CEILING: '3600',
      }),
    ).toMatchObject({ disconnectGraceSecondsCeiling: 60, keepAliveCountdownSecondsCeiling: 3600 });
    for (const name of [
      'DISCONNECT_GRACE_SECONDS_CEILING',
      'KEEP_ALIVE_COUNTDOWN_SECONDS_CEILING',
    ]) {
      expect(() => parseEnv({ [name]: '3601' })).toThrow(`${name} must be between 1 and 3600`);
      expect(() => parseEnv({ [name]: '0' })).toThrow(`${name} must be a positive integer`);
    }
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
      MAX_BUFFERED_BYTES: '98304',
      MAX_SESSION_MINUTES_CEILING: '600',
      INACTIVITY_LIMIT_MINUTES_CEILING: '30',
      TOKEN_REFRESH_ACTIVITIES: '4',
      TOKEN_REFRESH_MIN_SECONDS: '30',
      TOKEN_REFRESH_MAX_SECONDS: '120',
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
      maxBufferedBytes: 98304,
      maxSessionMinutesCeiling: 600,
      inactivityLimitMinutesCeiling: 30,
      tokenRefreshActivities: 4,
      tokenRefreshMinSeconds: 30,
      tokenRefreshMaxSeconds: 120,
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

  it('reads JOIN_METHODS_ALLOWED in canonical order, trimming whitespace (#10 AC1)', () => {
    expect(parseEnv({ JOIN_METHODS_ALLOWED: ' D , A ' }).joinMethodsAllowed).toEqual(['A', 'D']);
    expect(parseEnv({ JOIN_METHODS_ALLOWED: 'C' }).joinMethodsAllowed).toEqual(['C']);
    expect(parseEnv({ JOIN_METHODS_ALLOWED: 'B,C,D,A' }).joinMethodsAllowed).toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
  });

  it.each(['', ' ', 'A,,B', 'E', 'a', 'A,A', 'A;B', 'AB', 'A,B,'])(
    'rejects JOIN_METHODS_ALLOWED=%j naming the variable without the value (#10 AC1)',
    (bad) => {
      const err = errorOf({ JOIN_METHODS_ALLOWED: bad });
      expect(err.message).toBe(
        'JOIN_METHODS_ALLOWED must be a non-empty comma-separated list of distinct methods A, B, C, D',
      );
    },
  );

  it('bounds the join timer ceilings (#10 AC3)', () => {
    expect(errorOf({ QR_TICKET_SECONDS_CEILING: '29' }).message).toBe(
      'QR_TICKET_SECONDS_CEILING must be between 30 and 86400',
    );
    expect(errorOf({ QR_TICKET_SECONDS_CEILING: '86401' }).message).toBe(
      'QR_TICKET_SECONDS_CEILING must be between 30 and 86400',
    );
    expect(errorOf({ APPROVAL_TIMEOUT_SECONDS_CEILING: '14' }).message).toBe(
      'APPROVAL_TIMEOUT_SECONDS_CEILING must be between 15 and 3600',
    );
    expect(errorOf({ APPROVAL_TIMEOUT_SECONDS_CEILING: '3601' }).message).toBe(
      'APPROVAL_TIMEOUT_SECONDS_CEILING must be between 15 and 3600',
    );
    const env = parseEnv({
      QR_TICKET_SECONDS_CEILING: '30',
      APPROVAL_TIMEOUT_SECONDS_CEILING: '3600',
    });
    expect(env.qrTicketSecondsCeiling).toBe(30);
    expect(env.approvalTimeoutSecondsCeiling).toBe(3600);
  });

  it('rejects TOKEN_REFRESH_MAX_SECONDS above 3600 (#5)', () => {
    expect(errorOf({ TOKEN_REFRESH_MAX_SECONDS: '3601' }).message).toBe(
      'TOKEN_REFRESH_MAX_SECONDS must be between 1 and 3600',
    );
    expect(parseEnv({ TOKEN_REFRESH_MAX_SECONDS: '3600' }).tokenRefreshMaxSeconds).toBe(3600);
  });

  it('never reads the token secrets into ServerEnv (R4)', () => {
    const env = parseEnv({ TOKEN_SECRET: 'x'.repeat(40), TOKEN_SECRET_PREVIOUS: 'y'.repeat(40) });
    expect(JSON.stringify(env)).not.toMatch(/xxxx|yyyy/);
  });

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
    expect(err.problems).toEqual([
      'PORT must be a positive integer',
      'MAX_CONNECTIONS must be a positive integer',
    ]);
    expect(err.message).toBe(err.problems.join('\n'));
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
      expect(() =>
        parseEnv({ MAX_BUFFERED_BYTES: '65536', MAX_GROUP_SIZE_CEILING: '40' }),
      ).not.toThrow();
    });

    it('MAX_BUFFERED_BYTES fits the largest roster snapshot plus headroom (#13 5.5)', () => {
      // 100 x 2 + 2 entries of 320 bytes, a 256-byte envelope and 32 KiB headroom.
      expect(errorOf({ MAX_BUFFERED_BYTES: '97663' }).message).toBe(
        'MAX_BUFFERED_BYTES (97663) must be >= the largest roster snapshot plus headroom (97664) for MAX_GROUP_SIZE_CEILING (100)',
      );
      expect(() => parseEnv({ MAX_BUFFERED_BYTES: '97664' })).not.toThrow();
    });

    it('MAX_BUFFERED_BYTES fits the largest tokens.result frame (#5)', () => {
      const small = { MAX_MESSAGE_SIZE_CEILING: '1024', MAX_GROUP_SIZE_CEILING: '10' };
      expect(errorOf({ ...small, MAX_BUFFERED_BYTES: '4096' }).message).toContain(
        'MAX_BUFFERED_BYTES (4096) must be >= the largest tokens.result frame (45056)',
      );
      expect(errorOf({ ...small, MAX_BUFFERED_BYTES: '45055' }).message).toContain('tokens.result');
      expect(() => parseEnv({ ...small, MAX_BUFFERED_BYTES: '45056' })).not.toThrow();
    });

    it('TOKEN_REFRESH_MIN_SECONDS <= TOKEN_REFRESH_MAX_SECONDS (#5)', () => {
      const err = errorOf({ TOKEN_REFRESH_MIN_SECONDS: '301' });
      expect(err.message).toBe(
        'TOKEN_REFRESH_MIN_SECONDS (301) must be <= TOKEN_REFRESH_MAX_SECONDS (300)',
      );
      expect(() => parseEnv({ TOKEN_REFRESH_MIN_SECONDS: '300' })).not.toThrow();
    });
  });
});
