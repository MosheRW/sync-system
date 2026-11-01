import { describe, expect, it } from 'vitest';
import { SyncClientError } from '../src/errors.js';
import {
  type ConnectionState,
  type GroupState,
  type SyncIndicator,
  indicatorOf,
} from '../src/state.js';

const LIMITS = {
  maxGroupSize: 30,
  maxLeaderUpdatesPerSecond: 5,
  maxMessageBytes: 4096,
  maxSessionMinutes: 180,
};

const connections: Record<string, ConnectionState> = {
  idle: { status: 'idle' },
  connecting: { status: 'connecting' },
  connected: { status: 'connected', participantId: 'p', limits: LIMITS },
  reconnecting: { status: 'reconnecting', attempt: 1, delayMs: 500, retryAt: 0, attempting: false },
  closed: { status: 'closed', reason: 'fatal', error: new SyncClientError('INVALID_API_KEY') },
};

const leader: GroupState = {
  status: 'active',
  groupId: 'g',
  role: 'leader',
  metadata: null,
  hasPosition: false,
  position: undefined,
};
const member: GroupState = { ...leader, role: 'member', metadata: {} };
const rejoining: GroupState = {
  status: 'rejoining',
  groupId: 'g',
  role: 'member',
  metadata: {},
  hasPosition: false,
  position: undefined,
};
const ended: GroupState = { status: 'ended', groupId: 'g', reason: 'leader_disconnected' };
const rejoinFailed: GroupState = {
  status: 'ended',
  groupId: 'g',
  reason: 'rejoin_failed',
  code: 'GROUP_NOT_FOUND',
};
const appClosed: GroupState = { status: 'ended', groupId: 'g', reason: 'closed' };

describe('indicatorOf (AC25)', () => {
  it.each<[string, GroupState | null, SyncIndicator]>([
    // group ended, any connection state
    ...Object.keys(connections).map(
      (c) => [c, ended, 'leader_offline'] as [string, GroupState, SyncIndicator],
    ),
    ['connected', rejoinFailed, 'leader_offline'],
    // connecting / reconnecting with an active or rejoining group
    ['connecting', member, 'reconnecting'],
    ['reconnecting', member, 'reconnecting'],
    ['reconnecting', leader, 'reconnecting'],
    ['reconnecting', rejoining, 'reconnecting'],
    // connected
    ['connected', rejoining, 'reconnecting'],
    ['connected', member, 'following'],
    ['connected', leader, 'leading'],
    // anything else
    ['idle', null, 'none'],
    ['connected', null, 'none'],
    ['closed', null, 'none'],
    ['reconnecting', null, 'none'],
    ['closed', appClosed, 'none'],
  ])('%s + %o -> %s', (connection, group, expected) => {
    expect(indicatorOf({ connection: connections[connection]!, group })).toBe(expected);
  });
});
