import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { LEADER_ACTIVITY_PER_GROUP_PER_MINUTE } from '../src/limits/constants.js';
import { createGroupWithMembers } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import { type TestServer, startTestServer } from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

const MINUTE = 60_000;
/** Default limit 20 min, default countdown 60 s: the prompt is due after 19 min. */
const PROMPT_AFTER = 19 * MINUTE;

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

async function start() {
  const scheduler = new ManualScheduler();
  const store = new InMemoryGroupStore();
  ts = await startTestServer({ scheduler, store });
  const group = await createGroupWithMembers(ts, 1);
  return { scheduler, store, group };
}

function prompts(leader: TestClient): number {
  return leader.rosterFrames.filter((f) => f.type === 'keepalive.prompt').length;
}

/** No new prompt beyond the `seen` ones. */
async function noPrompt(leader: TestClient, seen = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(prompts(leader)).toBe(seen);
}

/** The next frame of `type`; a refreshed leader token may come first (activity counts). */
async function reply(client: TestClient, type: 'lock.changed' | 'error' | 'position.ack') {
  let message = await client.next();
  while (message.type === 'token.refreshed') message = await client.next();
  expect(message.type).toBe(type);
  return message;
}

describe('keep-alive (#13 AC15, AC16, AC30)', () => {
  it('prompts the leader only, at limit minus countdown, with the countdown as a duration', async () => {
    const { scheduler, group } = await start();
    scheduler.advance(PROMPT_AFTER - 1);
    await noPrompt(group.leader);
    scheduler.advance(1);
    expect(await group.leader.next('keepalive.prompt')).toEqual({
      type: 'keepalive.prompt',
      groupId: group.groupId,
      countdownMs: 60_000,
    });
    await group.members[0]!.expectNoMessage(30);
    expect(group.members[0]!.rosterFrames).toEqual([]);
  });

  it('restarts the inactivity period on every counted activity, without new timers', async () => {
    const { scheduler, group } = await start();
    const timers = scheduler.pending;
    scheduler.advance(10 * MINUTE);
    group.leader.send({ type: 'position.update', position: 1 });
    await group.leader.next('position.ack');
    scheduler.advance(5 * MINUTE);
    group.leader.send({ type: 'leader.activity', reqId: 'a', preview: { page: 9 } });
    expect(await group.leader.next('activity.ack')).toEqual({ type: 'activity.ack', reqId: 'a' });
    scheduler.advance(5 * MINUTE);
    group.leader.send({ type: 'group.lock' });
    await reply(group.leader, 'lock.changed');
    // The lazy prompt timer was re-armed only when it fired, never per activity.
    expect(scheduler.pending).toBe(timers);
    scheduler.advance(PROMPT_AFTER - 1);
    await noPrompt(group.leader);
    scheduler.advance(1);
    await group.leader.next('keepalive.prompt');
  });

  it('does not count refused, member or no actions (AC15)', async () => {
    const { scheduler, group } = await start();
    scheduler.advance(10 * MINUTE);
    const member = group.members[0]!;
    member.send({ type: 'position.update', position: 1 });
    await member.next('error');
    member.send({ type: 'leader.activity' });
    expect(await member.next('error')).toMatchObject({
      code: 'NOT_LEADER',
      message: 'Only the leader can send leader activity',
    });
    group.leader.send({ type: 'vice.set', participantId: group.leaderId });
    await group.leader.next('error');
    scheduler.advance(PROMPT_AFTER - 10 * MINUTE);
    await group.leader.next('keepalive.prompt');
  });

  it('an ack or any activity answers the prompt: keepalive.cleared, then a fresh period', async () => {
    const { scheduler, store, group } = await start();
    scheduler.advance(PROMPT_AFTER);
    await group.leader.next('keepalive.prompt');
    expect((await store.get('app-a', group.groupId))?.keepAlivePending).toBe(true);
    scheduler.advance(30_000);
    group.leader.send({ type: 'keepalive.ack', reqId: 'k' });
    expect(await group.leader.next('activity.ack')).toEqual({ type: 'activity.ack', reqId: 'k' });
    expect(await group.leader.next('keepalive.cleared')).toEqual({
      type: 'keepalive.cleared',
      groupId: group.groupId,
    });
    expect((await store.get('app-a', group.groupId))?.keepAlivePending).toBe(false);
    scheduler.advance(PROMPT_AFTER - 1);
    await noPrompt(group.leader, 1);
    scheduler.advance(1);
    await group.leader.next('keepalive.prompt');
    // A position update answers too.
    group.leader.send({ type: 'position.update', position: 2 });
    await reply(group.leader, 'position.ack');
    await group.leader.next('keepalive.cleared');
  });

  it('accepts the first ack of a prompt even with the activity budget spent (L5)', async () => {
    const { scheduler, group } = await start();
    scheduler.advance(PROMPT_AFTER - 30_000);
    for (let i = 0; i < LEADER_ACTIVITY_PER_GROUP_PER_MINUTE; i++) {
      group.leader.send({ type: 'leader.activity' });
      await group.leader.next('activity.ack');
    }
    group.leader.send({ type: 'leader.activity' });
    expect(await reply(group.leader, 'error')).toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Too many leader activity signals',
    });
    // The last accepted activity moved the prompt; reach it.
    scheduler.advance(PROMPT_AFTER);
    await group.leader.next('keepalive.prompt');
    group.leader.send({ type: 'keepalive.ack' });
    expect(await group.leader.next('activity.ack')).toMatchObject({ type: 'activity.ack' });
    await group.leader.next('keepalive.cleared');
  });

  it('logs a missed countdown without any name or ID', async () => {
    const { scheduler, group } = await start();
    scheduler.advance(PROMPT_AFTER);
    await group.leader.next('keepalive.prompt');
    scheduler.advance(60_000);
    await waitUntil(() => ts!.logs.events().includes('keepalive_missed'));
    const missed = ts!.logs.records().find((r) => r.event === 'keepalive_missed');
    expect(missed).toMatchObject({ namespace: 'app-a' });
    expect(JSON.stringify(missed)).not.toContain(group.groupId);
  });
});
