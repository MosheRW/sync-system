import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { TAKE_BACKS_PER_GROUP_PER_MINUTE } from '../src/limits/constants.js';
import { createGroupWithMembers, joinByCode, resumeWith } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';
import { claimsOf } from './helpers/tokens.js';

const MINUTE = 60_000;
const GRACE = 30_000;
/** Default limit plus the default refresh slack: a leader token's lat window. */
const WINDOW = 20 * MINUTE + 300_000;

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

/** The next frame of `type`, skipping any other frame in between. */
async function frameOf<T extends 'leader.granted' | 'error'>(client: TestClient, type: T) {
  for (;;) {
    const message = await client.next();
    if (message.type === type) return message as Extract<typeof message, { type: T }>;
  }
}

/** A group of leader + 2 members whose leader disconnected and was handed off. */
async function handedOff(maxGroupSize?: number) {
  const scheduler = new ManualScheduler();
  const store = new InMemoryGroupStore();
  ts = await startTestServer({
    scheduler,
    store,
    apps: [{ namespace: 'app-a', apiKey: KEY_A, ...(maxGroupSize ? { maxGroupSize } : {}) }],
  });
  const group = await createGroupWithMembers(ts, 2);
  const [next, other] = group.members as [TestClient, TestClient];
  await group.leader.close();
  await next.next('leader.offline');
  await other.next('leader.offline');
  scheduler.advance(GRACE);
  const granted = await next.next('leader.granted');
  await other.next('leader.changed');
  return { scheduler, store, group, next, other, granted };
}

describe('the displaced leader comes back (#13 AC24, AC25, D4)', () => {
  it('rejoins as a member with its old leader token and is offered the take-back', async () => {
    const { group } = await handedOff();
    const { client, reply } = await resumeWith(ts!, group.leaderToken, {
      blockList: [group.memberIds[0]],
      locked: true,
    });
    expect(reply).toMatchObject({
      type: 'group.joined',
      role: 'member',
      participantId: group.leaderId,
    });
    expect(claimsOf((reply as { token: string }).token).role).toBe('member');
    expect(await client.next('takeback.offered')).toEqual({
      type: 'takeback.offered',
      groupId: group.groupId,
    });
  });

  it('still rejoins as a member after its lat window', async () => {
    const { scheduler, group, next } = await handedOff();
    // Keep the new leader active so nothing pauses meanwhile.
    for (let t = 0; t < WINDOW; t += 10 * MINUTE) {
      scheduler.advance(10 * MINUTE);
      next.send({ type: 'leader.activity' });
      await next.next('activity.ack');
    }
    const { reply } = await resumeWith(ts!, group.leaderToken);
    expect(reply).toMatchObject({ type: 'group.joined', role: 'member' });
  });

  it('takes the lead back: the roles swap and the slot moves to the replaced leader', async () => {
    const { scheduler, store, group, next, other } = await handedOff();
    const { client: back } = await resumeWith(ts!, group.leaderToken);
    await back.next('takeback.offered');
    back.send({ type: 'leader.takeBack', reqId: 't' });
    const granted = await back.next('leader.granted');
    expect(granted).toMatchObject({ reqId: 't', reason: 'take_back', groupId: group.groupId });
    expect(claimsOf(granted.token)).toMatchObject({ role: 'leader', pid: group.leaderId });
    const lost = await next.next('leader.lost');
    expect(lost).toMatchObject({ reason: 'take_back', takeBackAvailable: true });
    expect(claimsOf(lost.token)).toMatchObject({ role: 'member', pid: group.memberIds[0] });
    expect(await other.next('leader.changed')).toEqual({
      type: 'leader.changed',
      groupId: group.groupId,
      reason: 'take_back',
    });
    expect(await store.get('app-a', group.groupId)).toMatchObject({
      leaderId: group.leaderId,
      displacedLeaderId: group.memberIds[0],
      escalated: false,
    });
    // The new leader leads; the old one is refused at once.
    back.send({ type: 'position.update', position: 1 });
    await back.next('position.ack');
    next.send({ type: 'position.update', position: 2 });
    expect(await frameOf(next, 'error')).toMatchObject({ code: 'NOT_LEADER' });
    // A fresh inactivity period for the returning leader.
    scheduler.advance(19 * MINUTE - 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(back.rosterFrames.some((f) => f.type === 'keepalive.prompt')).toBe(false);
  });

  it('refuses anyone else with NOT_ALLOWED, spending no budget', async () => {
    const { group, next, other } = await handedOff();
    for (const client of [next, other]) {
      for (let i = 0; i <= TAKE_BACKS_PER_GROUP_PER_MINUTE; i++) {
        client.send({ type: 'leader.takeBack' });
        expect(await client.next('error')).toMatchObject({
          code: 'NOT_ALLOWED',
          message: 'Only the displaced leader can take back the lead',
        });
      }
    }
    const { client: back } = await resumeWith(ts!, group.leaderToken);
    back.send({ type: 'leader.takeBack' });
    expect(await frameOf(back, 'leader.granted')).toMatchObject({ reason: 'take_back' });
  });

  it('rate-limits a take-back ping-pong to 3 per group per minute', async () => {
    const { group, next } = await handedOff();
    const { client: back } = await resumeWith(ts!, group.leaderToken);
    const pair = [back, next];
    for (let i = 0; i < TAKE_BACKS_PER_GROUP_PER_MINUTE; i++) {
      const client = pair[i % 2]!;
      client.send({ type: 'leader.takeBack' });
      expect(await frameOf(client, 'leader.granted')).toMatchObject({ reason: 'take_back' });
    }
    const client = pair[TAKE_BACKS_PER_GROUP_PER_MINUTE % 2]!;
    client.send({ type: 'leader.takeBack' });
    expect(await frameOf(client, 'error')).toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Too many take-backs',
    });
  });

  it('a displaced leader that leaves loses the slot (L3)', async () => {
    const { store, group } = await handedOff();
    const { client: back } = await resumeWith(ts!, group.leaderToken);
    await back.next('takeback.offered');
    back.send({ type: 'group.leave' });
    await back.next('group.left');
    expect((await store.get('app-a', group.groupId))?.displacedLeaderId).toBeUndefined();
    const { client: again } = await resumeWith(ts!, group.leaderToken);
    again.send({ type: 'leader.takeBack' });
    expect(await frameOf(again, 'error')).toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it('the offer is gone once the group ends', async () => {
    const { group, next } = await handedOff();
    next.send({ type: 'group.end' });
    await next.next('group.ended');
    expect((await resumeWith(ts!, group.leaderToken)).reply).toMatchObject({
      code: 'GROUP_ENDED',
    });
  });

  it('decides LEADER_CANNOT_LEAVE from the live record right after a handoff', async () => {
    const { group, next } = await handedOff();
    next.send({ type: 'group.leave' });
    expect(await next.next('error')).toMatchObject({ code: 'LEADER_CANNOT_LEAVE' });
    const { client: back } = await resumeWith(ts!, group.leaderToken);
    await back.next('takeback.offered');
    back.send({ type: 'group.leave' });
    expect(await back.next('group.left')).toMatchObject({ groupId: group.groupId });
  });

  it('the current leader returns with its old member token, inside its lat window (L2)', async () => {
    const { group, next, other } = await handedOff();
    // The new leader's own member token, from before it led; the lat bound
    // past which it is refused is in resume.test.ts.
    await next.close();
    await other.next('leader.offline');
    const back = await resumeWith(ts!, group.memberTokens[0]);
    expect(back.reply).toMatchObject({ type: 'group.resumed', role: 'leader' });
  });

  it('never evicts the displaced leader from the roster under join churn (RC10, M3)', async () => {
    const { store, group, next } = await handedOff(4);
    for (let i = 0; i < 8; i++) {
      const { client } = await joinByCode(ts!, group);
      await client.close();
    }
    const roster = (await store.get('app-a', group.groupId))!.roster.map((e) => e.pid);
    expect(roster).toContain(group.leaderId);
    next.send({ type: 'member.remove', participantId: group.leaderId });
    expect(await next.next('member.removed')).toMatchObject({ participantId: group.leaderId });
    expect((await store.get('app-a', group.groupId))?.displacedLeaderId).toBeUndefined();
  });
});
