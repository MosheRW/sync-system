import { SyncClientError } from '@mosherw/sync-system-react';
import { describe, expect, it } from 'vitest';
import {
  type LeaderAction,
  MAX_RETRY_AFTER_MS,
  clampRetryAfter,
  leaderActionError,
} from '../src/group/leader-errors.js';

const err = (code: string, details?: unknown) =>
  new SyncClientError(code as never, details === undefined ? {} : { details: details as never });

const ALL: LeaderAction[] = [
  'setVice',
  'clearVice',
  'remove',
  'lock',
  'unlock',
  'bring',
  'keepAlive',
  'takeBack',
];

describe('leader action errors (#25 design 7.10, 7.11, AC58)', () => {
  it.each(ALL)('%s: the common rows', (action) => {
    expect(leaderActionError(action, err('NOT_IN_GROUP'))).toBeNull();
    expect(leaderActionError(action, err('NOT_LEADER'))).toEqual({
      key: 'errNotLeader',
      close: true,
    });
    for (const code of ['NOT_CONNECTED', 'CONNECTION_LOST', 'REQUEST_TIMEOUT']) {
      expect(leaderActionError(action, err(code))).toEqual({ key: 'errNetwork' });
    }
    expect(leaderActionError(action, err('RATE_LIMITED', { retryAfterMs: 5000 }))).toEqual({
      key: 'errRateLimited',
      retryAfterMs: 5000,
    });
    expect(leaderActionError(action, err('RATE_LIMITED'))).toEqual({
      key: 'errRateLimitedNoTime',
    });
    expect(leaderActionError(action, err('SOMETHING_NEW'))).toEqual({ key: 'errServer' });
  });

  it.each<[LeaderAction, string, object]>([
    ['setVice', 'NOT_ALLOWED', { key: 'errViceAway', withName: true }],
    ['setVice', 'PARTICIPANT_NOT_FOUND', { key: 'errPersonGone', withName: true }],
    ['clearVice', 'PARTICIPANT_NOT_FOUND', { key: 'errPersonGone', withName: true }],
    ['remove', 'BLOCK_LIST_FULL', { key: 'errBlockListFull' }],
    ['remove', 'CODES_EXHAUSTED', { key: 'errRemoveCodes' }],
    [
      'remove',
      'PARTICIPANT_NOT_FOUND',
      { key: 'errPersonGone', withName: true, close: true, aboveList: true },
    ],
    ['remove', 'NOT_ALLOWED', { key: 'errServer' }],
    ['takeBack', 'NOT_ALLOWED', { key: 'takeBackNotAllowed', close: true, refused: true }],
    ['lock', 'NOT_ALLOWED', { key: 'errServer' }],
    ['bring', 'NOT_ALLOWED', { key: 'errServer' }],
  ])('%s %s', (action, code, expected) => {
    expect(leaderActionError(action, err(code))).toEqual(expected);
  });

  it('clamps a server wait: finite, positive, at most 10 minutes (R22, L2)', () => {
    expect(clampRetryAfter(1500)).toBe(1500);
    expect(clampRetryAfter(MAX_RETRY_AFTER_MS)).toBe(MAX_RETRY_AFTER_MS);
    for (const value of [Number.NaN, -1, 0, 1e12, Number.POSITIVE_INFINITY, '5', null]) {
      expect(clampRetryAfter(value)).toBeUndefined();
    }
    expect(leaderActionError('lock', err('RATE_LIMITED', { retryAfterMs: 1e12 }))).toEqual({
      key: 'errRateLimitedNoTime',
    });
  });
});
