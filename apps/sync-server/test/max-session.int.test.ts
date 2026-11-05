import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { createGroupWithMembers } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { expireHold } from './helpers/lifecycle.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

const MINUTE = 60_000;

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

describe('max session time (#5 AC21, Q2)', () => {
  it('ends a live group at createdAt + maxSessionMinutes, leader included', async () => {
    const scheduler = new ManualScheduler();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({
      scheduler,
      store,
      // An inactivity limit past the max session: no keep-alive before the end.
      apps: [
        { namespace: 'app-a', apiKey: KEY_A, maxSessionMinutes: 30, inactivityLimitMinutes: 60 },
      ],
    });
    const created = scheduler.now();
    const { groupId, leader, members } = await createGroupWithMembers(ts, 1);

    scheduler.advanceTo(created + 30 * MINUTE - 1);
    await leader.expectNoMessage(30);
    scheduler.advanceTo(created + 30 * MINUTE);
    const ended = { type: 'group.ended', groupId, reason: 'max_session' };
    expect(await leader.next('group.ended')).toEqual(ended);
    expect(await members[0]!.next('group.ended')).toEqual(ended);
    await waitUntil(() => store.size === 0);

    // Everyone is groupless and connected.
    leader.send({ type: 'position.update', position: 1 });
    expect(await leader.next('error')).toMatchObject({ code: 'NOT_IN_GROUP' });
  });

  it('ends a frozen group with max_session when that comes before the leader timeout', async () => {
    const scheduler = new ManualScheduler();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({
      scheduler,
      store,
      // Frozen mode (#13 AC21): no handoff before the bounds under test.
      apps: [
        { namespace: 'app-a', apiKey: KEY_A, maxSessionMinutes: 10, defaultHandoff: 'frozen' },
      ],
    });
    const created = scheduler.now();
    const { leader, members } = await createGroupWithMembers(ts, 1);
    scheduler.advance(5 * MINUTE);
    await leader.close();
    await members[0]!.next('leader.offline');
    scheduler.advanceTo(created + 10 * MINUTE);
    expect((await members[0]!.next('group.ended')).reason).toBe('max_session');
    await waitUntil(() => store.size === 0);
    expect(scheduler.pending).toBe(0);
  });

  it('ends a frozen group with leader_timeout when that comes first', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({
      scheduler,
      // Frozen mode (#13 AC21): no handoff before the bounds under test.
      apps: [
        { namespace: 'app-a', apiKey: KEY_A, inactivityLimitMinutes: 1, defaultHandoff: 'frozen' },
      ],
    });
    const { leader, members } = await createGroupWithMembers(ts, 1);
    await leader.close();
    await members[0]!.next('leader.offline');
    scheduler.advance(MINUTE + 300_000);
    expect((await members[0]!.next('group.ended')).reason).toBe('leader_timeout');
  });

  it('an emptied group’s timers are cancelled', async () => {
    const scheduler = new ManualScheduler();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ scheduler, store });
    const { leader, groupId } = await createGroupWithMembers(ts, 0);
    // Max session and the keep-alive prompt (#13 6.3).
    expect(scheduler.pending).toBe(2);
    await leader.close();
    // Held for the grace period, then ended (#13 Q-G).
    await expireHold(scheduler, store, groupId);
    await waitUntil(() => scheduler.pending === 0);
  });
});
