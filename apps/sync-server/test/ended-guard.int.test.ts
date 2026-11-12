import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EndedGroups } from '../src/groups/ended-groups.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { type TestServer, startTestServer } from './helpers/test-server.js';

const MINUTE = 60_000;
/** The app defaults: 20 min inactivity limit, 300 s max refresh, 5 min clock skew. */
const GUARD_SPAN = 20 * MINUTE + 300_000 + 300_000;

let ts: TestServer | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await ts?.close();
  ts = undefined;
});

describe('ended-group guard of a recreated group (#13 6.9 layer 1)', () => {
  it('guards until the process start plus the lat window and the clock skew', async () => {
    const tokenSecrets = { current: randomBytes(32), source: 'env' as const };
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ tokenSecrets, scheduler });
    const group = await createGroupWithMembers(ts, 0, { metadata: {} });
    await ts.close();
    scheduler.advance(2 * MINUTE);
    ts = await startTestServer({ tokenSecrets, scheduler });
    if (ts.server.storage().kind !== 'memory') return;
    const startedAt = scheduler.now();
    const { client: leader } = await resumeWith(ts, group.leaderToken, { metadata: {} });
    const remember = vi.spyOn(EndedGroups.prototype, 'remember');
    leader.send({ type: 'group.end' });
    await leader.next('group.ended');
    expect(remember).toHaveBeenCalledOnce();
    const [, , deadline, guardUntil] = remember.mock.calls[0]!;
    expect(guardUntil).toBe(Math.min(deadline, startedAt + GUARD_SPAN));
    expect(guardUntil).toBeGreaterThan(scheduler.now());
  });
});
