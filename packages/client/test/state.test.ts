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
  connected: { status: 'connected', participantId: 'p', namespace: 'app-a', limits: LIMITS },
  reconnecting: { status: 'reconnecting', attempt: 1, delayMs: 500, retryAt: 0, attempting: false },
  closed: { status: 'closed', reason: 'fatal', error: new SyncClientError('INVALID_API_KEY') },
};

const leader: GroupState = {
  status: 'active',
  groupId: 'g',
  role: 'leader',
  metadata: {},
  hasPosition: false,
  position: undefined,
  leaderOnline: true,
};
const member: GroupState = { ...leader, role: 'member' };
const memberLeaderOffline: GroupState = { ...leader, role: 'member', leaderOnline: false };
const rejoining: GroupState = {
  status: 'rejoining',
  groupId: 'g',
  role: 'member',
  metadata: {},
  hasPosition: false,
  position: undefined,
};
const rejoiningLeader: GroupState = { ...rejoining, role: 'leader' };
const waiting: GroupState = { status: 'waiting', groupId: 'g', role: 'member' };
const endedReasons = [
  'ended_by_leader',
  'leader_timeout',
  'max_session',
  'replaced',
  'removed',
  'left',
  'rejoin_failed',
  'closed',
] as const;

describe('indicatorOf (#5 AC36, Q-E)', () => {
  it.each<[string, GroupState | null, SyncIndicator]>([
    // An ended group, any reason, any connection state: none (Q-E).
    ...Object.keys(connections).flatMap((c) =>
      endedReasons.map(
        (reason) =>
          [c, { status: 'ended', groupId: 'g', reason }, 'none'] as [
            string,
            GroupState,
            SyncIndicator,
          ],
      ),
    ),
    // connecting / reconnecting with an active, rejoining or waiting group
    ['connecting', member, 'reconnecting'],
    ['reconnecting', member, 'reconnecting'],
    ['reconnecting', leader, 'reconnecting'],
    ['reconnecting', rejoining, 'reconnecting'],
    ['reconnecting', waiting, 'reconnecting'],
    // connected
    ['connected', rejoining, 'reconnecting'],
    ['connected', rejoiningLeader, 'reconnecting'],
    ['connected', waiting, 'leader_offline'],
    ['connected', memberLeaderOffline, 'leader_offline'],
    ['connected', member, 'following'],
    ['connected', leader, 'leading'],
    // anything else
    ['idle', null, 'none'],
    ['connected', null, 'none'],
    ['closed', null, 'none'],
    ['reconnecting', null, 'none'],
    ['closed', member, 'none'],
  ])('%s + %o -> %s', (connection, group, expected) => {
    expect(indicatorOf({ connection: connections[connection]!, group })).toBe(expected);
  });
});
