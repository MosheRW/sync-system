import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { JoinService } from '../src/joins/join-service.js';
import { LeaderControls } from '../src/lifecycle/leader-controls.js';
import { createGroupWithMembers } from './helpers/groups.js';
import { GRACE_MS } from './helpers/lifecycle.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';
import { claimsOf } from './helpers/tokens.js';
import { waitUntil } from './helpers/wait.js';

const MINUTE = 60_000;

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
  vi.restoreAllMocks();
});

async function start(maxSessionMinutes: number, handoff: 'auto' | 'frozen' = 'auto') {
  const scheduler = new ManualScheduler();
  const store = new InMemoryGroupStore();
  ts = await startTestServer({
    scheduler,
    store,
    apps: [{ namespace: 'app-a', apiKey: KEY_A, maxSessionMinutes, defaultHandoff: handoff }],
  });
  return { scheduler, store };
}

async function frameOf(client: TestClient, type: string) {
  for (;;) {
    const message = await client.next();
    if (message.type === type) return message;
  }
}

describe('max session in every state (#13 AC18)', () => {
  it('ends a group paused by a disconnect, mid-grace, at createdAt + max', async () => {
    const { scheduler, store } = await start(1);
    const created = scheduler.now();
    const group = await createGroupWithMembers(ts!, 1);
    scheduler.advance(45_000);
    await group.leader.close();
    await group.members[0]!.next('leader.offline');
    scheduler.advanceTo(created + MINUTE - 1);
    await group.members[0]!.expectNoMessage(30);
    scheduler.advanceTo(created + MINUTE);
    expect(await group.members[0]!.next('group.ended')).toMatchObject({ reason: 'max_session' });
    await waitUntil(() => store.size === 0);
    expect(scheduler.pending).toBe(0);
  });

  it('ends an inactive-paused group and a handed-off group at createdAt + max', async () => {
    const { scheduler } = await start(25);
    const created = scheduler.now();
    const group = await createGroupWithMembers(ts!, 1);
    scheduler.advance(19 * MINUTE);
    await group.leader.next('keepalive.prompt');
    scheduler.advance(MINUTE);
    await group.members[0]!.next('leader.offline');
    scheduler.advance(GRACE_MS);
    const granted = await frameOf(group.members[0]!, 'leader.granted');
    // The new leader's token keeps the original creation time (AC18).
    expect(claimsOf((granted as { token: string }).token).gct).toBe(created);
    scheduler.advanceTo(created + 25 * MINUTE);
    expect(await frameOf(group.members[0]!, 'group.ended')).toMatchObject({
      reason: 'max_session',
    });
  });

  it('a handoff never extends the max session', async () => {
    const { scheduler, store } = await start(2);
    const created = scheduler.now();
    const group = await createGroupWithMembers(ts!, 1);
    scheduler.advance(MINUTE);
    await group.leader.close();
    await group.members[0]!.next('leader.offline');
    scheduler.advance(GRACE_MS);
    await frameOf(group.members[0]!, 'leader.granted');
    scheduler.advanceTo(created + 2 * MINUTE);
    await frameOf(group.members[0]!, 'group.ended');
    await waitUntil(() => store.size === 0);
  });
});

describe('timer cleanup (#13 AC19, RC13, RC2)', () => {
  it('leaves only max session and the prompt after a handoff and a take-back', async () => {
    const { scheduler } = await start(180);
    const group = await createGroupWithMembers(ts!, 1);
    await group.leader.close();
    await group.members[0]!.next('leader.offline');
    // Max session, frozen bound and grace end.
    expect(scheduler.pending).toBe(3);
    scheduler.advance(GRACE_MS);
    await frameOf(group.members[0]!, 'leader.granted');
    // Max session and the new leader's prompt (and its refresh timer, if any).
    await waitUntil(() => scheduler.pending <= 3);
    expect(scheduler.pending).toBeGreaterThanOrEqual(2);
  });

  it('no timer fires after an end, for any reason; server.close() leaves none', async () => {
    const { scheduler, store } = await start(180);
    const ended = await createGroupWithMembers(ts!, 1);
    ended.leader.send({ type: 'group.end' });
    await ended.leader.next('group.ended');
    const emptied = await createGroupWithMembers(ts!, 0);
    await emptied.leader.close();
    await waitUntil(async () => (await store.get('app-a', emptied.groupId))?.pause !== undefined);
    scheduler.advance(GRACE_MS);
    await waitUntil(() => store.size === 0);
    expect(scheduler.pending).toBe(0);
    scheduler.advance(10 * 60 * MINUTE);
    expect(ts!.logs.events()).not.toContain('timer_error');
    const live = await createGroupWithMembers(ts!, 1);
    await live.leader.close();
    await live.members[0]!.next('leader.offline');
    expect(scheduler.pending).toBeGreaterThan(0);
    await ts!.close();
    ts = undefined;
    expect(scheduler.pending).toBe(0);
  });

  it('no per-group budget is left after an end, for any reason, or after server.close()', async () => {
    const forget = vi.spyOn(LeaderControls.prototype, 'forgetGroup');
    const close = vi.spyOn(LeaderControls.prototype, 'close');
    const joinsClose = vi.spyOn(JoinService.prototype, 'close');
    const { scheduler, store } = await start(180);
    // Charges the vice, lock and activity budgets of the group.
    const charge = async (group: Awaited<ReturnType<typeof createGroupWithMembers>>) => {
      group.leader.send({ type: 'leader.activity' });
      await group.leader.next('activity.ack');
      group.leader.send({ type: 'group.lock' });
      await group.leader.next('lock.changed');
      if (group.memberIds.length > 0) {
        group.leader.send({ type: 'vice.set', participantId: group.memberIds[0] });
        await group.leader.next('vice.updated');
      }
    };
    const ended = await createGroupWithMembers(ts!, 1);
    await charge(ended);
    ended.leader.send({ type: 'group.end' });
    await ended.leader.next('group.ended');
    // The server's own instance, found through its first end.
    const instance = forget.mock.contexts[0] as LeaderControls;
    expect(forget).toHaveBeenLastCalledWith('app-a', ended.groupId);
    expect(instance.limiterSize).toBe(0);

    // An `empty` end after the leader's grace.
    const emptied = await createGroupWithMembers(ts!, 0);
    await charge(emptied);
    expect(instance.limiterSize).toBeGreaterThan(0);
    await emptied.leader.close();
    await waitUntil(async () => (await store.get('app-a', emptied.groupId))?.pause !== undefined);
    scheduler.advance(GRACE_MS);
    await waitUntil(() => store.size === 0);
    expect(forget).toHaveBeenLastCalledWith('app-a', emptied.groupId);
    expect(instance.limiterSize).toBe(0);

    // A live group's budgets go with server.close().
    const live = await createGroupWithMembers(ts!, 1);
    await charge(live);
    expect(instance.limiterSize).toBeGreaterThan(0);
    await ts!.close();
    ts = undefined;
    expect(close).toHaveBeenCalled();
    expect(instance.limiterSize).toBe(0);
    // The join budgets (per connection and per group) go too (#10 AC31).
    const joins = joinsClose.mock.contexts[0] as JoinService;
    expect(joins.limiterSize).toBe(0);
  });
});
