import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { createGroupWithMembers, joinByCode, resumeWith } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

const MINUTE = 60_000;
/** Default limit 20 min and countdown 60 s. */
const PROMPT_AFTER = 19 * MINUTE;
const LIMIT = 20 * MINUTE;
/** Default limit plus the default refresh slack (300 s): the frozen bound. */
const WINDOW = LIMIT + 300_000;

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

async function start(handoff: 'auto' | 'frozen' = 'auto') {
  const scheduler = new ManualScheduler();
  const store = new InMemoryGroupStore();
  ts = await startTestServer({
    scheduler,
    store,
    apps: [{ namespace: 'app-a', apiKey: KEY_A, defaultHandoff: handoff }],
  });
  return { scheduler, store };
}

describe('disconnection grace (#13 AC14, D8)', () => {
  it('pauses with the grace as a duration; a return inside it changes no role', async () => {
    const { scheduler, store } = await start();
    const group = await createGroupWithMembers(ts!, 1);
    await group.leader.close();
    expect(await group.members[0]!.next('leader.offline')).toEqual({
      type: 'leader.offline',
      groupId: group.groupId,
      cause: 'disconnected',
      graceMs: 30_000,
    });
    expect((await store.get('app-a', group.groupId))?.pause).toEqual({
      cause: 'offline',
      graceEndsAt: scheduler.now() + 30_000,
    });
    // A joiner during the pause sees it (leaderOnline false).
    scheduler.advance(10_000);
    const { reply } = await joinByCode(ts!, group);
    expect(reply).toMatchObject({
      type: 'group.joined',
      leaderOnline: false,
      leaderPause: { cause: 'disconnected', graceMs: 20_000 },
    });
    scheduler.advance(19_000);
    const back = await resumeWith(ts!, group.leaderToken);
    expect(back.reply).toMatchObject({ type: 'group.resumed', participantId: group.leaderId });
    expect(await group.members[0]!.next('leader.online')).toEqual({
      type: 'leader.online',
      groupId: group.groupId,
    });
    const record = await store.get('app-a', group.groupId);
    expect(record).toMatchObject({
      leaderId: group.leaderId,
      pause: undefined,
      leaderOnline: true,
    });
    // Max session and the keep-alive prompt only: grace and frozen end are gone.
    expect(scheduler.pending).toBe(2);
  });

  it('frozen mode pauses without a grace period', async () => {
    const { store } = await start('frozen');
    const group = await createGroupWithMembers(ts!, 1);
    await group.leader.close();
    expect(await group.members[0]!.next('leader.offline')).toEqual({
      type: 'leader.offline',
      groupId: group.groupId,
      cause: 'disconnected',
    });
    expect((await store.get('app-a', group.groupId))?.pause).toEqual({ cause: 'offline' });
  });
});

/** Reaches the prompt, then lets its countdown run out (timers fire in turn). */
async function missKeepAlive(scheduler: ManualScheduler, leader: TestClient): Promise<void> {
  scheduler.advance(PROMPT_AFTER);
  await leader.next('keepalive.prompt');
  scheduler.advance(LIMIT - PROMPT_AFTER);
}

describe('missed keep-alive (#13 AC17, AC21)', () => {
  it('pauses as inactive for the grace period; the next activity makes the group live', async () => {
    const { scheduler, store } = await start();
    const group = await createGroupWithMembers(ts!, 1);
    scheduler.advance(PROMPT_AFTER);
    await group.leader.next('keepalive.prompt');
    scheduler.advance(60_000);
    expect(await group.members[0]!.next('leader.offline')).toEqual({
      type: 'leader.offline',
      groupId: group.groupId,
      cause: 'inactive',
      graceMs: 30_000,
    });
    expect((await store.get('app-a', group.groupId))?.pause).toMatchObject({ cause: 'inactive' });
    scheduler.advance(5_000);
    group.leader.send({ type: 'leader.activity' });
    await group.leader.next('activity.ack');
    await group.leader.next('keepalive.cleared');
    expect(await group.members[0]!.next('leader.online')).toMatchObject({
      groupId: group.groupId,
    });
    expect((await store.get('app-a', group.groupId))?.pause).toBeUndefined();
  });

  it('keeps the earlier grace end when an inactive leader then disconnects (no extension)', async () => {
    const { scheduler, store } = await start();
    const group = await createGroupWithMembers(ts!, 1);
    await missKeepAlive(scheduler, group.leader);
    await group.members[0]!.next('leader.offline');
    const graceEndsAt = (await store.get('app-a', group.groupId))?.pause?.graceEndsAt;
    scheduler.advance(10_000);
    await group.leader.close();
    expect(await group.members[0]!.next('leader.offline')).toEqual({
      type: 'leader.offline',
      groupId: group.groupId,
      cause: 'disconnected',
      graceMs: 20_000,
    });
    expect((await store.get('app-a', group.groupId))?.pause).toEqual({
      cause: 'offline',
      graceEndsAt,
    });
  });

  it('in frozen mode ends at the recovery bound with leader_timeout (Q1.3)', async () => {
    const { scheduler, store } = await start('frozen');
    const group = await createGroupWithMembers(ts!, 1);
    await missKeepAlive(scheduler, group.leader);
    expect(await group.members[0]!.next('leader.offline')).toEqual({
      type: 'leader.offline',
      groupId: group.groupId,
      cause: 'inactive',
    });
    scheduler.advance(WINDOW - LIMIT - 1);
    await group.members[0]!.expectNoMessage(30);
    scheduler.advance(1);
    expect(await group.members[0]!.next('group.ended')).toMatchObject({
      reason: 'leader_timeout',
    });
    await waitUntil(() => store.size === 0);
  });
});
