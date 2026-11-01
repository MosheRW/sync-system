import { describe, expect, it } from 'vitest';
import {
  CloseCode,
  ErrorCode,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from '../src/index.js';

describe('protocol constants', () => {
  it('declares protocol version 1 with minimum 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MIN_CLIENT_PROTOCOL_VERSION).toBeLessThanOrEqual(PROTOCOL_VERSION);
  });

  it('uses each error code as its own string value', () => {
    for (const [key, value] of Object.entries(ErrorCode)) {
      expect(value).toBe(key);
    }
  });

  it('keeps flood and leader rate limiting distinct', () => {
    expect(ErrorCode.TOO_MANY_MESSAGES).not.toBe(ErrorCode.RATE_LIMITED);
    expect(ErrorCode.APP_CONNECTION_LIMIT).toBe('APP_CONNECTION_LIMIT');
  });

  it('defines the application close codes', () => {
    expect(CloseCode.HANDSHAKE_REJECTED).toBe(4001);
    expect(CloseCode.HANDSHAKE_TIMEOUT).toBe(4002);
    expect(CloseCode.APP_CONNECTION_LIMIT).toBe(4003);
    expect(CloseCode.POLICY_VIOLATION).toBe(4008);
    expect(new Set(Object.values(CloseCode)).size).toBe(Object.values(CloseCode).length);
  });
});
