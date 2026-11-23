import type { ErrorMessage } from '@mosherw/sync-system-protocol';
import { describe, expect, it } from 'vitest';
import {
  ACTION_MESSAGES,
  ClientErrorCode,
  FATAL_HANDSHAKE_CODES,
  SyncClientError,
  fromServerError,
  invalidServerMessage,
  isSyncClientError,
} from '../src/errors.js';

function serverError(
  code: ErrorMessage['code'],
  details?: unknown,
  message = 'text',
): ErrorMessage {
  const frame = JSON.parse(
    JSON.stringify({ type: 'error', code, message, ...(details === undefined ? {} : { details }) }),
  ) as ErrorMessage;
  return frame;
}

describe('SyncClientError', () => {
  it('has a fixed message, code, source and fatal flag', () => {
    const error = new SyncClientError('NOT_CONNECTED');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SyncClientError');
    expect(error.code).toBe('NOT_CONNECTED');
    expect(error.source).toBe('client');
    expect(error.fatal).toBe(false);
    expect(error.details).toBeUndefined();
    expect(error.message).toBe('Not connected');
  });

  it('isSyncClientError narrows by code', () => {
    const error = new SyncClientError('INVALID_OPTIONS', { details: { field: 'url' } });
    expect(isSyncClientError(error)).toBe(true);
    expect(isSyncClientError(error, 'INVALID_OPTIONS')).toBe(true);
    expect(isSyncClientError(error, 'CLOSED')).toBe(false);
    expect(isSyncClientError(new Error('x'))).toBe(false);
    if (isSyncClientError(error, 'INVALID_OPTIONS')) expect(error.details.field).toBe('url');
  });

  it('contains every protocol code and the client codes', () => {
    expect(ClientErrorCode.GROUP_FULL).toBe('GROUP_FULL');
    expect(ClientErrorCode.REQUEST_IN_PROGRESS).toBe('REQUEST_IN_PROGRESS');
  });

  it('marks the Q4 and Q-A handshake codes fatal and not the busy ones', () => {
    for (const code of [
      'INVALID_API_KEY',
      'INVALID_APP_VERSION',
      'PROTOCOL_TOO_OLD',
      'APP_VERSION_TOO_OLD',
      'INVALID_MESSAGE',
      'HANDSHAKE_REQUIRED',
      'ALREADY_AUTHENTICATED',
    ] as const) {
      expect(FATAL_HANDSHAKE_CODES.has(code)).toBe(true);
    }
    for (const code of ['APP_CONNECTION_LIMIT', 'HANDSHAKE_TIMEOUT', 'INTERNAL_ERROR'] as const) {
      expect(FATAL_HANDSHAKE_CODES.has(code)).toBe(false);
    }
  });
});

describe('fromServerError', () => {
  it('copies typed details', () => {
    const tooOld = fromServerError(serverError('PROTOCOL_TOO_OLD', { minProtocolVersion: 2 }), {
      request: 'hello',
      fatal: true,
    });
    expect(tooOld.source).toBe('server');
    expect(tooOld.fatal).toBe(true);
    expect(tooOld.request).toBe('hello');
    expect(tooOld.details).toEqual({ minProtocolVersion: 2 });

    const app = fromServerError(serverError('APP_VERSION_TOO_OLD', { minAppVersion: '2.0.0' }));
    expect(app.details).toEqual({ minAppVersion: '2.0.0' });

    const full = fromServerError(serverError('GROUP_FULL', { maxGroupSize: 2 }));
    expect(full.details).toEqual({ maxGroupSize: 2 });

    const large = fromServerError(
      serverError('MESSAGE_TOO_LARGE', { field: 'position', limitBytes: 256, other: 1 }),
    );
    expect(large.details).toEqual({ field: 'position', limitBytes: 256 });

    const rate = fromServerError(
      serverError('RATE_LIMITED', { maxLeaderUpdatesPerSecond: 5, retryAfterMs: 120 }),
    );
    expect(rate.details).toEqual({ maxLeaderUpdatesPerSecond: 5, retryAfterMs: 120 });

    const groups = fromServerError(
      serverError('APP_GROUP_LIMIT', { maxLiveGroups: 10_000, count: 9_999 }),
      { request: 'group.create' },
    );
    expect(groups.details).toEqual({ maxLiveGroups: 10_000 });
    expect(groups.message).toBe('The app has too many live groups; try later');
  });

  it('parses APP_GROUP_LIMIT details tolerantly (#12)', () => {
    for (const maxLiveGroups of [-1, '10000', null, Number.NaN]) {
      expect(fromServerError(serverError('APP_GROUP_LIMIT', { maxLiveGroups })).details).toEqual(
        {},
      );
    }
    expect(fromServerError(serverError('APP_GROUP_LIMIT')).details).toEqual({});
  });

  it('drops numbers that are not finite and non-negative, or not numbers (M1)', () => {
    for (const retryAfterMs of [-1, '5', null, true, { a: 1 }]) {
      const error = fromServerError(serverError('RATE_LIMITED', { retryAfterMs }));
      expect(error.details).toEqual({});
    }
  });

  it('ignores inherited and __proto__ properties (L1)', () => {
    const fromProto = fromServerError(
      JSON.parse(
        '{"type":"error","code":"RATE_LIMITED","message":"x","details":{"__proto__":{"retryAfterMs":1}}}',
      ) as ErrorMessage,
    );
    expect(fromProto.details).toEqual({});
    expect(Object.keys(fromProto.details as object)).toEqual([]);

    const inherited = Object.create({ retryAfterMs: 5 }) as Record<string, unknown>;
    const viaPrototype = fromServerError({
      type: 'error',
      code: 'RATE_LIMITED',
      message: 'x',
      details: inherited as ErrorMessage['details'],
    });
    expect(viaPrototype.details).toEqual({});
    expect(Object.getPrototypeOf(viaPrototype.details)).toBe(Object.prototype);
  });

  it('keeps unknown field values out and caps strings (L1, L2)', () => {
    const error = fromServerError(
      serverError('APP_VERSION_TOO_OLD', { minAppVersion: 'x'.repeat(500) }, 'm'.repeat(10_000)),
    );
    expect((error.details as { minAppVersion: string }).minAppVersion).toHaveLength(64);
    expect(error.serverMessage).toHaveLength(256);
    expect(error.message).toBe('This app version is too old; please update');
  });

  it('has no details for codes without them', () => {
    expect(fromServerError(serverError('GROUP_NOT_FOUND', { x: 1 })).details).toBeUndefined();
  });
});

describe('invalidServerMessage (L2)', () => {
  it('keeps at most 10 issues of at most 128 characters', () => {
    const issues = Array.from({ length: 50 }, (_, i) => `${'p'.repeat(300)}${i}: invalid_type`);
    const error = invalidServerMessage(issues, 'group.joinByCode');
    expect(error.details.issues).toHaveLength(10);
    for (const issue of error.details.issues) expect(issue.length).toBeLessThanOrEqual(128);
    expect(error.request).toBe('group.joinByCode');
  });
});

describe('error serialization (L3)', () => {
  it('holds no cause, frame, payload or group ID', () => {
    const groupId = 'G'.repeat(43);
    const frame = serverError('GROUP_NOT_FOUND', { groupId, marker: 'PAYLOAD-MARKER' });
    const error = fromServerError(frame, { request: 'group.joinByCode' });
    const json = JSON.stringify(error);
    expect(error.cause).toBeUndefined();
    expect(json).not.toContain(groupId);
    expect(json).not.toContain('PAYLOAD-MARKER');
    expect(JSON.parse(json)).toMatchObject({ name: 'SyncClientError', code: 'GROUP_NOT_FOUND' });
  });
});

describe('per-request texts for shared codes (#7 A1, aligned with the server)', () => {
  it.each([
    ['RATE_LIMITED', 'position.update', 'Too many position updates'],
    ['RATE_LIMITED', 'tokens.check', 'Too many token checks'],
    ['NOT_LEADER', 'position.update', 'Only the leader can update the position'],
    ['NOT_LEADER', 'group.end', 'Only the leader can end the group'],
    ['NOT_LEADER', 'blocklist.set', 'Only the leader can set the block list'],
    ['RATE_LIMITED', 'group.joinByCode', 'Too many join attempts'],
    ['RATE_LIMITED', 'group.joinByQr', 'Too many join attempts'],
  ] as const)('%s for %s: %s', (code, request, text) => {
    expect(fromServerError(serverError(code), { request }).message).toBe(text);
    expect(new SyncClientError(code, { request }).message).toBe(text);
  });

  it('keeps the position-update text when the request is not known', () => {
    expect(new SyncClientError('RATE_LIMITED').message).toBe('Too many position updates');
    expect(new SyncClientError('NOT_LEADER').message).toBe(
      'Only the leader can update the position',
    );
    expect(fromServerError(serverError('NOT_LEADER'), { request: 'group.leave' }).message).toBe(
      'Only the leader can update the position',
    );
  });

  it('gives each request its own fixed text', () => {
    for (const rows of Object.values(ACTION_MESSAGES)) {
      // Both join requests share "Too many join attempts", as on the server (#10 4.4).
      const texts = Object.entries(rows)
        .filter(([request]) => request !== 'group.joinByQr')
        .map(([, text]) => text);
      expect(new Set(texts).size).toBe(texts.length);
      for (const text of texts) expect(text).not.toMatch(/[{}$%<>]/);
    }
  });
});
