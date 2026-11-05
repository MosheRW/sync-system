import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { createGroupWithMembers } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import {
  KEY_A,
  type TestAppInput,
  type TestServer,
  startTestServer,
} from './helpers/test-server.js';
import { claimsOf } from './helpers/tokens.js';
import { waitUntil } from './helpers/wait.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

describe('handoff mode at creation (#13 AC3)', () => {
  it('stores auto, frozen or the app default; refuses an unknown mode', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({
      store,
      apps: [{ namespace: 'app-a', apiKey: KEY_A, defaultHandoff: 'frozen' }],
    });
    const leader = await ts.connectReady();
    const modes: Array<[string | undefined, string]> = [
      ['auto', 'auto'],
      ['frozen', 'frozen'],
      [undefined, 'frozen'],
    ];
    for (const [handoff, stored] of modes) {
      const client = await ts.connectReady();
      client.send({ type: 'group.create', metadata: {}, ...(handoff ? { handoff } : {}) });
      const created = await client.next('group.created');
      expect((await store.get('app-a', created.groupId))?.handoff).toBe(stored);
    }
    leader.send({ type: 'group.create', reqId: 'x', metadata: {}, handoff: 'manual' });
    expect(await leader.next('error')).toMatchObject({ reqId: 'x', code: 'INVALID_MESSAGE' });
    expect(store.size).toBe(3);
  });
});

const MINUTE = 60_000;
const PROMPT_AFTER = 19 * MINUTE;
const LIMIT = 20 * MINUTE;
const GRACE = 30_000;

async function startAuto(extra: Partial<TestAppInput> = {}) {
  const scheduler = new ManualScheduler();
  const store = new InMemoryGroupStore();
  ts = await startTestServer({
    scheduler,
    store,
    apps: [{ namespace: 'app-a', apiKey: KEY_A, ...extra }],
  });
  return { scheduler, store };
}

/** Reaches the prompt, then lets its countdown run out (timers fire in turn). */
async function missKeepAlive(scheduler: ManualScheduler, leader: TestClient): Promise<void> {
  scheduler.advance(PROMPT_AFTER);
  await leader.next('keepalive.prompt');
  scheduler.advance(LIMIT - PROMPT_AFTER);
}

describe('automatic handoff (#13 AC20, AC23, Q2.2, Q2.3)', () => {
  it('hands a disconnected leader’s group to the earliest admitted connected member', async () => {
    const { scheduler, store } = await startAuto();
    const group = await createGroupWithMembers(ts!, 2);
    const [first, second] = group.members as [TestClient, TestClient];
    const before = claimsOf(group.leaderToken);
    await group.leader.close();
    await first.next('leader.offline');
    await second.next('leader.offline');
    scheduler.advance(GRACE - 1);
    await first.expectNoMessage(30);
    scheduler.advance(1);
    const granted = await first.next('leader.granted');
    expect(granted).toMatchObject({
      type: 'leader.granted',
      groupId: group.groupId,
      reason: 'handoff_disconnect',
      state: { blockList: [], locked: false, handoff: 'auto' },
      joinMethods: ['A', 'D'],
      codes: { generation: group.codes.generation },
    });
    const claims = claimsOf(granted.token);
    expect(claims).toMatchObject({ role: 'leader', pid: group.memberIds[0], gct: before.gct });
    expect(claims.term).toBeGreaterThan(before.term);
    expect(claims.lat).toBe(scheduler.now());
    const roster = await first.next('roster.snapshot');
    expect(roster.participants.find((p) => p.participantId === group.memberIds[0])?.role).toBe(
      'leader',
    );
    // Others learn only that the leader changed: no ID.
    expect(await second.next('leader.changed')).toEqual({
      type: 'leader.changed',
      groupId: group.groupId,
      reason: 'handoff_disconnect',
    });
    const record = await store.get('app-a', group.groupId);
    expect(record).toMatchObject({
      leaderId: group.memberIds[0],
      displacedLeaderId: group.leaderId,
      escalated: false,
      leaderOnline: true,
      pause: undefined,
    });
    expect(record?.participantIds).not.toContain(group.leaderId);
    // The new leader leads; the members follow it.
    first.send({ type: 'position.update', position: 'p' });
    await first.next('position.ack');
    expect(await second.next('position.updated')).toMatchObject({ position: 'p' });
    // Its inactivity period starts fresh (Q1.5).
    scheduler.advance(PROMPT_AFTER - 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(first.rosterFrames.some((f) => f.type === 'keepalive.prompt')).toBe(false);
  });

  it('prefers a connected vice-leader and skips an offline one (AC12)', async () => {
    const { scheduler } = await startAuto();
    const group = await createGroupWithMembers(ts!, 3);
    const [a, b, c] = group.members as [TestClient, TestClient, TestClient];
    group.leader.send({ type: 'vice.set', participantId: group.memberIds[2] });
    await group.leader.next('vice.updated');
    await c.next('vice.changed');
    await group.leader.close();
    await c.next('leader.offline');
    scheduler.advance(GRACE);
    expect(await c.next('leader.granted')).toMatchObject({ state: { handoff: 'auto' } });
    await a.next('leader.offline');
    expect(await a.next('leader.changed')).toMatchObject({ reason: 'handoff_disconnect' });
    await b.next('leader.offline');
  });

  it('skips an offline vice; a second handoff never picks the displaced leader (Q2.3)', async () => {
    const { scheduler, store } = await startAuto();
    const group = await createGroupWithMembers(ts!, 3);
    const [a, b, c] = group.members as [TestClient, TestClient, TestClient];
    group.leader.send({ type: 'vice.set', participantId: group.memberIds[2] });
    await group.leader.next('vice.updated');
    await c.close();
    await group.leader.close();
    await a.next('leader.offline');
    scheduler.advance(GRACE);
    await a.next('leader.granted');
    // The new leader leaves too: the next one is b, not the first leader.
    await a.close();
    await b.next('leader.offline');
    await b.next('leader.changed');
    await b.next('leader.offline');
    scheduler.advance(GRACE);
    await b.next('leader.granted');
    expect(await store.get('app-a', group.groupId)).toMatchObject({
      leaderId: group.memberIds[1],
      displacedLeaderId: group.memberIds[0],
      viceId: group.memberIds[2],
    });
  });

  it('after a missed keep-alive: handoff_inactivity, the old leader keeps a member token', async () => {
    const { scheduler, store } = await startAuto();
    const group = await createGroupWithMembers(ts!, 1);
    await missKeepAlive(scheduler, group.leader);
    await group.members[0]!.next('leader.offline');
    scheduler.advance(GRACE);
    expect(await group.members[0]!.next('leader.granted')).toMatchObject({
      reason: 'handoff_inactivity',
    });
    const lost = await group.leader.next('leader.lost');
    expect(lost).toMatchObject({
      type: 'leader.lost',
      groupId: group.groupId,
      reason: 'handoff_inactivity',
      takeBackAvailable: true,
    });
    expect(claimsOf(lost.token)).toMatchObject({ role: 'member', pid: group.leaderId });
    expect(await store.get('app-a', group.groupId)).toMatchObject({
      leaderId: group.memberIds[0],
      displacedLeaderId: group.leaderId,
      escalated: true,
    });
    // The old connection is refused as a leader at once (AC6, AC8).
    group.leader.send({ type: 'position.update', position: 1 });
    expect(await group.leader.next('error')).toMatchObject({ code: 'NOT_LEADER' });
  });

  it('with nobody to hand off to, stays paused until the frozen bound (AC21)', async () => {
    const { scheduler, store } = await startAuto();
    const group = await createGroupWithMembers(ts!, 0);
    await missKeepAlive(scheduler, group.leader);
    // The pause is applied before the clock moves on.
    await waitUntil(async () => (await store.get('app-a', group.groupId))?.pause !== undefined);
    scheduler.advance(GRACE);
    expect((await store.get('app-a', group.groupId))?.leaderId).toBe(group.leaderId);
    scheduler.advance(300_000 - GRACE);
    expect(await group.leader.next('group.ended')).toMatchObject({ reason: 'leader_timeout' });
  });
});
