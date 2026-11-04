import { JOIN_REQUEST_ID_PATTERN } from '@sync-system/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/groups/session.js';
import { ApprovalQueue, newRequestId } from '../src/joins/approval-queue.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';

function session(): Session {
  return {
    connectionId: 'c',
    app: {} as Session['app'],
    membership: undefined,
    isOpen: () => true,
    deliver: () => {},
    afterPending: (task) => task(),
  };
}

const G = 'app-a:G';
const H = 'app-a:H';

function request(s: Session, groupKey = G, deadline = 1000) {
  return { groupKey, groupId: groupKey.slice(6), session: s, displayName: 'Dana', deadline };
}

describe('ApprovalQueue (#10 AC22, R11)', () => {
  it('issues 22-character CSPRNG request IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newRequestId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(JOIN_REQUEST_ID_PATTERN);
  });

  it('adds up to 10 requests per group and sets the session back-pointer', () => {
    const queue = new ApprovalQueue(new ManualScheduler(0));
    const sessions = Array.from({ length: 11 }, () => session());
    for (const s of sessions.slice(0, 10)) {
      const added = queue.add(request(s), () => {});
      expect(added).not.toBe('full');
      if (added === 'full') return;
      expect(s.pendingJoin).toEqual({ groupKey: G, groupId: 'G', requestId: added.requestId });
    }
    expect(queue.add(request(sessions[10]!), () => {})).toBe('full');
    expect(sessions[10]!.pendingJoin).toBeUndefined();
    // Another group has its own limit.
    expect(queue.add(request(sessions[10]!, H), () => {})).not.toBe('full');
    expect(queue.size).toBe(11);
  });

  it('settles exactly once: the first take wins, later ones find nothing', () => {
    const scheduler = new ManualScheduler(0);
    const queue = new ApprovalQueue(scheduler);
    const s = session();
    const added = queue.add(request(s), () => {});
    if (added === 'full') throw new Error('full');
    expect(scheduler.pending).toBe(1);
    const taken = queue.take(G, added.requestId);
    expect(taken).toMatchObject({ requestId: added.requestId, current: true, displayName: 'Dana' });
    expect(s.pendingJoin).toBeUndefined();
    expect(scheduler.pending).toBe(0);
    expect(queue.take(G, added.requestId)).toBeUndefined();
    expect(queue.takeBySession(s)).toBeUndefined();
    expect(queue.drain(G)).toEqual([]);
  });

  it('finds a request only in its own group', () => {
    const queue = new ApprovalQueue(new ManualScheduler(0));
    const added = queue.add(request(session()), () => {});
    if (added === 'full') throw new Error('full');
    expect(queue.take(H, added.requestId)).toBeUndefined();
    expect(queue.take(G, added.requestId)).toBeDefined();
  });

  it('takes by session and drains a group', () => {
    const queue = new ApprovalQueue(new ManualScheduler(0));
    const a = session();
    const b = session();
    queue.add(request(a), () => {});
    queue.add(request(b), () => {});
    expect(queue.takeBySession(a)?.session).toBe(a);
    expect(a.pendingJoin).toBeUndefined();
    expect(queue.list(G).map((r) => r.session)).toEqual([b]);
    expect(queue.drain(G).map((r) => r.session)).toEqual([b]);
    expect(b.pendingJoin).toBeUndefined();
    expect(queue.size).toBe(0);
  });

  it('fires the deadline timer with the request ID, and clearAll cancels every timer', () => {
    const scheduler = new ManualScheduler(0);
    const queue = new ApprovalQueue(scheduler);
    const onTimeout = vi.fn();
    const added = queue.add(request(session(), G, 500), onTimeout);
    if (added === 'full') throw new Error('full');
    scheduler.advance(500);
    expect(onTimeout).toHaveBeenCalledWith(added.requestId);
    queue.add(request(session(), G, 900), onTimeout);
    queue.add(request(session(), H, 900), onTimeout);
    queue.clearAll();
    expect(scheduler.pending).toBe(0);
    expect(queue.size).toBe(0);
  });

  it('reports a request that is no longer the session current one', () => {
    const queue = new ApprovalQueue(new ManualScheduler(0));
    const s = session();
    const added = queue.add(request(s), () => {});
    if (added === 'full') throw new Error('full');
    s.pendingJoin = undefined;
    expect(queue.take(G, added.requestId)?.current).toBe(false);
  });
});
