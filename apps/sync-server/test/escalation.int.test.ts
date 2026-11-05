import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { createGroupWithMembers } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import { type TestServer, startTestServer } from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

const MINUTE = 60_000;
const PROMPT_AFTER = 19 * MINUTE;
const COUNTDOWN = 60_000;
const GRACE = 30_000;

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

/** Reaches the prompt, then lets its countdown run out (timers fire in turn). */
async function missKeepAlive(scheduler: ManualScheduler, leader: TestClient): Promise<void> {
  scheduler.advance(PROMPT_AFTER);
  await leader.next('keepalive.prompt');
  scheduler.advance(COUNTDOWN);
}

async function inactivityHandoff() {
  const scheduler = new ManualScheduler();
  const store = new InMemoryGroupStore();
  ts = await startTestServer({ scheduler, store });
  const group = await createGroupWithMembers(ts, 2);
  const [next, other] = group.members as [TestClient, TestClient];
  await missKeepAlive(scheduler, group.leader);
  await next.next('leader.offline');
  await other.next('leader.offline');
  scheduler.advance(GRACE);
  await next.next('leader.granted');
  await other.next('leader.changed');
  return { scheduler, store, group, next, other };
}

describe('one-step escalation (#13 AC22, D9, Q-B)', () => {
  it('ends the group with inactivity when the next leader also misses, with no grace', async () => {
    const { scheduler, store, group, next, other } = await inactivityHandoff();
    expect((await store.get('app-a', group.groupId))?.escalated).toBe(true);
    await missKeepAlive(scheduler, next);
    const ended = { type: 'group.ended', groupId: group.groupId, reason: 'inactivity' };
    expect(await next.next('group.ended')).toEqual(ended);
    expect(await other.next('group.ended')).toEqual(ended);
    await waitUntil(() => store.size === 0);
    const record = ts!.logs.records().find((r) => r.event === 'group_ended');
    expect(record).toMatchObject({ endReason: 'inactivity' });
  });

  it('a new leader that acted once is treated like any leader: pause and handoff again', async () => {
    const { scheduler, store, group, next, other } = await inactivityHandoff();
    scheduler.advance(MINUTE);
    next.send({ type: 'leader.activity' });
    await next.next('activity.ack');
    expect((await store.get('app-a', group.groupId))?.escalated).toBe(false);
    await missKeepAlive(scheduler, next);
    expect(await other.next('leader.offline')).toMatchObject({ cause: 'inactive' });
    expect(store.size).toBe(1);
  });

  it('a disconnect handoff does not escalate', async () => {
    const scheduler = new ManualScheduler();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ scheduler, store });
    const group = await createGroupWithMembers(ts, 2);
    await group.leader.close();
    await group.members[0]!.next('leader.offline');
    scheduler.advance(GRACE);
    await group.members[0]!.next('leader.granted');
    expect((await store.get('app-a', group.groupId))?.escalated).toBe(false);
    await missKeepAlive(scheduler, group.members[0]!);
    expect(await group.members[1]!.next('leader.offline')).toMatchObject({ cause: 'disconnected' });
    expect(await group.members[1]!.next('leader.changed')).toBeDefined();
    expect(await group.members[1]!.next('leader.offline')).toMatchObject({ cause: 'inactive' });
  });
});
