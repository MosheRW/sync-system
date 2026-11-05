import { describe, expect, it } from 'vitest';
import type { GroupRecord } from '../src/groups/group-store.js';
import type { Session } from '../src/groups/session.js';
import {
  authorizeLeader,
  isGuardError,
  isParticipantConnected,
} from '../src/lifecycle/leader-guard.js';

const GID = 'G'.repeat(43);
const LEADER = 'leader-pid';
const MEMBER = 'member-pid';

function record(leaderId = LEADER): GroupRecord {
  return { id: GID, leaderId } as GroupRecord;
}

const plain = { parked: undefined, pendingJoin: undefined };

describe('authorizeLeader (#13 D1, RC1)', () => {
  it('passes the owned leader of the live record', () => {
    const owned = { groupId: GID, participantId: LEADER };
    expect(
      authorizeLeader({ session: plain, owned, groupId: GID, record: record() }, 'group.end'),
    ).toBe(owned);
  });

  it('refuses a member, a former leader and a vice with NOT_LEADER and the action text', () => {
    const owned = { groupId: GID, participantId: MEMBER };
    const result = authorizeLeader(
      { session: plain, owned, groupId: GID, record: record() },
      'codes.rotate',
    );
    expect(result).toEqual({
      type: 'error',
      code: 'NOT_LEADER',
      message: 'Only the leader can rotate the codes',
    });
    // The same participant after a handoff made someone else the leader.
    const formerLeader = { groupId: GID, participantId: LEADER };
    expect(
      authorizeLeader(
        { session: plain, owned: formerLeader, groupId: GID, record: record(MEMBER) },
        'group.end',
      ),
    ).toMatchObject({ code: 'NOT_LEADER' });
  });

  it('refuses a parked session and a pending joiner with NOT_LEADER, first', () => {
    const parked = { parked: { groupKey: 'k', groupId: GID, participantId: LEADER } };
    const pending = { pendingJoin: { groupKey: 'k', groupId: GID, requestId: 'r' } };
    for (const session of [parked, pending] as Array<Pick<Session, 'parked' | 'pendingJoin'>>) {
      expect(
        authorizeLeader(
          {
            session,
            owned: { groupId: GID, participantId: LEADER },
            groupId: GID,
            record: record(),
          },
          'join.approve',
        ),
      ).toMatchObject({ code: 'NOT_LEADER', message: 'Only the leader can approve join requests' });
    }
  });

  it('answers NOT_IN_GROUP without an owned membership, for another group, or with no record', () => {
    const cases = [
      { owned: undefined, groupId: GID, record: record() },
      { owned: { groupId: 'other', participantId: LEADER }, groupId: GID, record: record() },
      { owned: { groupId: GID, participantId: LEADER }, groupId: GID, record: undefined },
    ];
    for (const input of cases) {
      const result = authorizeLeader({ session: plain, ...input }, 'blocklist.set');
      expect(isGuardError(result) && result.code).toBe('NOT_IN_GROUP');
    }
  });
});

describe('isParticipantConnected (#13 RC19)', () => {
  it('is true only for an open owner', () => {
    expect(isParticipantConnected(undefined)).toBe(false);
    expect(isParticipantConnected({ isOpen: () => false } as Session)).toBe(false);
    expect(isParticipantConnected({ isOpen: () => true } as Session)).toBe(true);
  });
});
