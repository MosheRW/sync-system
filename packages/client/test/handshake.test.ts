import type { ErrorMessage, WelcomeMessage } from '@sync-system/protocol';
import { describe, expect, it } from 'vitest';
import {
  buildHello,
  checkHelloOk,
  checkWelcome,
  classifyClose,
  classifyHandshakeError,
} from '../src/handshake.js';
import { CLIENT_PROTOCOL_VERSION, MIN_SERVER_PROTOCOL_VERSION } from '../src/version.js';

function welcome(protocolVersion: number, minProtocolVersion: number): WelcomeMessage {
  return { type: 'welcome', protocolVersion, minProtocolVersion };
}

function error(code: ErrorMessage['code'], details?: ErrorMessage['details']): ErrorMessage {
  return { type: 'error', code, message: 'm', ...(details ? { details } : {}) };
}

describe('checkWelcome (AC12, Q5)', () => {
  it('supports exactly protocol 1', () => {
    expect(CLIENT_PROTOCOL_VERSION).toBe(1);
    expect(MIN_SERVER_PROTOCOL_VERSION).toBe(1);
  });

  it('accepts an equal or newer compatible server', () => {
    expect(checkWelcome(welcome(1, 1))).toBeUndefined();
    expect(checkWelcome(welcome(3, 1))).toBeUndefined();
  });

  it('refuses a server whose minimum is above the client', () => {
    const result = checkWelcome(welcome(3, 2));
    expect(result?.code).toBe('SERVER_UNSUPPORTED');
    expect(result?.fatal).toBe(true);
    expect(result?.details).toEqual({
      clientProtocolVersion: 1,
      minServerProtocolVersion: 1,
      serverProtocolVersion: 3,
      serverMinProtocolVersion: 2,
    });
  });

  it('refuses a server below the client minimum', () => {
    expect(checkWelcome(welcome(0, 0))?.details).toMatchObject({ serverProtocolVersion: 0 });
  });
});

describe('checkHelloOk (M1, R2-L2)', () => {
  const base = { type: 'hello.ok' as const, participantId: 'p' };

  it('accepts limits in bounds', () => {
    const limits = { maxGroupSize: 30, maxLeaderUpdatesPerSecond: 5, maxMessageBytes: 4096 };
    expect(checkHelloOk({ ...base, limits }, welcome(1, 1))).toBeUndefined();
  });

  it('is fatal SERVER_UNSUPPORTED with the limit name when out of bounds', () => {
    const limits = { maxGroupSize: 30, maxLeaderUpdatesPerSecond: 5, maxMessageBytes: 2 ** 53 };
    const result = checkHelloOk({ ...base, limits }, welcome(1, 1));
    expect(result?.fatal).toBe(true);
    expect(result?.details.limit).toBe('maxMessageBytes');
  });
});

describe('buildHello (AC8)', () => {
  it('carries the protocol version, key and app version', () => {
    expect(buildHello('c1', 'key', '1.2.3')).toEqual({
      type: 'hello',
      reqId: 'c1',
      protocolVersion: 1,
      apiKey: 'key',
      appVersion: '1.2.3',
    });
  });
});

describe('classifyHandshakeError (Q4, Q-A, AC13, AC14)', () => {
  it.each([
    'INVALID_API_KEY',
    'INVALID_APP_VERSION',
    'PROTOCOL_TOO_OLD',
    'APP_VERSION_TOO_OLD',
    'INVALID_MESSAGE',
    'HANDSHAKE_REQUIRED',
    'ALREADY_AUTHENTICATED',
  ] as const)('%s is fatal', (code) => {
    const { error: result, busy } = classifyHandshakeError(error(code));
    expect(result.code).toBe(code);
    expect(result.fatal).toBe(true);
    expect(result.source).toBe('server');
    expect(result.request).toBe('hello');
    expect(busy).toBeUndefined();
  });

  it.each(['HANDSHAKE_TIMEOUT', 'INTERNAL_ERROR'] as const)('%s is retryable', (code) => {
    expect(classifyHandshakeError(error(code)).error.fatal).toBe(false);
  });

  it('APP_CONNECTION_LIMIT is retryable and a busy signal', () => {
    const result = classifyHandshakeError(error('APP_CONNECTION_LIMIT'));
    expect(result.error.fatal).toBe(false);
    expect(result.busy).toBe('app_connection_limit');
  });

  it('carries typed details (AC13)', () => {
    expect(
      classifyHandshakeError(error('PROTOCOL_TOO_OLD', { minProtocolVersion: 2 })).error.details,
    ).toEqual({ minProtocolVersion: 2 });
    expect(
      classifyHandshakeError(error('APP_VERSION_TOO_OLD', { minAppVersion: '2.0.0' })).error
        .details,
    ).toEqual({ minAppVersion: '2.0.0' });
  });
});

describe('classifyClose', () => {
  it('a bare 4001 during the handshake is fatal HANDSHAKE_REJECTED (Q-A)', () => {
    const result = classifyClose(4001, true);
    expect(result.error.code).toBe('HANDSHAKE_REJECTED');
    expect(result.error.fatal).toBe(true);
  });

  it.each([
    [4002, true, 'HANDSHAKE_TIMEOUT', undefined],
    [4003, true, 'APP_CONNECTION_LIMIT', 'app_connection_limit'],
    [4008, false, 'TOO_MANY_MESSAGES', 'too_many_messages'],
    [1001, false, 'CONNECTION_LOST', 'going_away'],
    [1006, true, 'CONNECTION_LOST', undefined],
    [1000, false, 'CONNECTION_LOST', undefined],
    [4001, false, 'CONNECTION_LOST', undefined],
  ] as const)('close %d (handshake: %s) is retryable %s', (code, during, expected, busy) => {
    const result = classifyClose(code, during);
    expect(result.error.fatal).toBe(false);
    expect(result.error.code).toBe(expected);
    expect(result.busy).toBe(busy);
  });
});
