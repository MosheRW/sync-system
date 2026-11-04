import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { VICE_CHANGES_PER_GROUP_PER_MINUTE } from '../src/limits/constants.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, KEY_B, type TestServer, startTestServer } from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

async function viceSet(leader: TestClient, participantId: string, reqId = 'v') {
  leader.send({ type: 'vice.set', reqId, participantId });
  return leader.next();
}

describe('vice-leader designation (#13 AC10-AC12)', () => {
  it('sets, replaces and clears; only the old and new vice are told', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ store, scheduler: new ManualScheduler() });
    const group = await createGroupWithMembers(ts, 3);
    const [a, b, c] = group.members as [TestClient, TestClient, TestClient];
    const [idA, idB] = group.memberIds as [string, string];

    expect(await viceSet(group.leader, idA)).toEqual({
      type: 'vice.updated',
      reqId: 'v',
      groupId: group.groupId,
      viceId: idA,
    });
    expect(await a.next('vice.changed')).toEqual({
      type: 'vice.changed',
      groupId: group.groupId,
      isVice: true,
    });
    expect((await store.get('app-a', group.groupId))?.viceId).toBe(idA);

    expect(await viceSet(group.leader, idB)).toMatchObject({ viceId: idB });
    expect(await a.next('vice.changed')).toMatchObject({ isVice: false });
    expect(await b.next('vice.changed')).toMatchObject({ isVice: true });

    group.leader.send({ type: 'vice.clear', reqId: 'c' });
    expect(await group.leader.next()).toEqual({
      type: 'vice.updated',
      reqId: 'c',
      groupId: group.groupId,
      viceId: null,
    });
    expect(await b.next('vice.changed')).toMatchObject({ isVice: false });
    // The third member was never told anything about the vice (Q3.3).
    await c.expectNoMessage(30);
    const roleChanges = group.leader.rosterFrames.filter(
      (f) => f.type === 'roster.updated' && f.participant.participantId === idA,
    );
    expect(roleChanges.map((f) => f.type === 'roster.updated' && f.participant.role)).toContain(
      'vice-leader',
    );
  });

  it('answers one byte-identical PARTICIPANT_NOT_FOUND for every unknown target', async () => {
    ts = await startTestServer({ scheduler: new ManualScheduler() });
    const group = await createGroupWithMembers(ts, 1);
    const other = await createGroupWithMembers(ts, 1);
    const otherApp = await createGroupWithMembers(ts, 1, { apiKey: KEY_B });
    group.leader.send({ type: 'blocklist.set', blockList: [group.memberIds[0]] });
    await group.leader.next('blocklist.ack');
    const replies = [];
    for (const target of [
      randomUUID(),
      other.memberIds[0]!,
      otherApp.memberIds[0]!,
      group.memberIds[0]!,
    ]) {
      replies.push(await viceSet(group.leader, target, 'same'));
    }
    for (const reply of replies) {
      expect(reply).toEqual({
        type: 'error',
        reqId: 'same',
        code: 'PARTICIPANT_NOT_FOUND',
        message: 'Participant not found',
      });
    }
  });

  it('refuses the leader itself and an offline member with NOT_ALLOWED', async () => {
    ts = await startTestServer({ scheduler: new ManualScheduler() });
    const group = await createGroupWithMembers(ts, 1);
    expect(await viceSet(group.leader, group.leaderId)).toMatchObject({
      code: 'NOT_ALLOWED',
      message: 'This participant cannot be the vice-leader now',
    });
    await group.members[0]!.close();
    await waitUntil(() =>
      group.leader.rosterFrames.some(
        (f) => f.type === 'roster.updated' && !f.participant.connected,
      ),
    );
    expect(await viceSet(group.leader, group.memberIds[0]!)).toMatchObject({
      code: 'NOT_ALLOWED',
    });
  });

  it('refuses a member and the vice itself with NOT_LEADER (AC7)', async () => {
    ts = await startTestServer({ scheduler: new ManualScheduler() });
    const group = await createGroupWithMembers(ts, 2);
    await viceSet(group.leader, group.memberIds[0]!);
    await group.members[0]!.next('vice.changed');
    for (const client of group.members) {
      client.send({ type: 'vice.set', participantId: group.memberIds[1] });
      const reply = await client.next('error');
      expect(reply).toMatchObject({
        code: 'NOT_LEADER',
        message: 'Only the leader can choose the vice-leader',
      });
      client.send({ type: 'vice.clear' });
      expect(await client.next('error')).toMatchObject({ code: 'NOT_LEADER' });
    }
  });

  it('keeps the designation over a disconnect and tells the vice again when it returns', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ store, scheduler: new ManualScheduler() });
    const group = await createGroupWithMembers(ts, 1);
    const id = group.memberIds[0]!;
    await viceSet(group.leader, id);
    await group.members[0]!.close();
    expect((await store.get('app-a', group.groupId))?.viceId).toBe(id);
    const { client, reply } = await resumeWith(ts, group.memberTokens[0]);
    expect(reply.type).toBe('group.joined');
    expect(await client.next('vice.changed')).toMatchObject({ isVice: true });
  });

  it('clears the designation when the vice leaves or is blocked (AC12)', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ store, scheduler: new ManualScheduler() });
    const group = await createGroupWithMembers(ts, 2);
    const [a, b] = group.members as [TestClient, TestClient];
    await viceSet(group.leader, group.memberIds[0]!);
    await a.next('vice.changed');
    a.send({ type: 'group.leave' });
    await a.next('group.left');
    expect((await store.get('app-a', group.groupId))?.viceId).toBeUndefined();
    await viceSet(group.leader, group.memberIds[1]!);
    await b.next('vice.changed');
    group.leader.send({ type: 'blocklist.set', blockList: [group.memberIds[1]] });
    await group.leader.next('blocklist.ack');
    expect((await store.get('app-a', group.groupId))?.viceId).toBeUndefined();
  });

  it('rate-limits vice changes per group; refused requests spend nothing (RC2)', async () => {
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ scheduler });
    const group = await createGroupWithMembers(ts, 1);
    // Non-leader and invalid requests first: none of them spends budget.
    group.members[0]!.send({ type: 'vice.clear' });
    await group.members[0]!.next('error');
    await viceSet(group.leader, randomUUID());
    for (let i = 0; i < VICE_CHANGES_PER_GROUP_PER_MINUTE; i++) {
      group.leader.send({ type: 'vice.clear' });
      expect(await group.leader.next()).toMatchObject({ type: 'vice.updated' });
    }
    group.leader.send({ type: 'vice.clear' });
    const limited = await group.leader.next('error');
    expect(limited).toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Too many vice-leader clears',
      details: { retryAfterMs: expect.any(Number) as number },
    });
    scheduler.advance(60_000);
    group.leader.send({ type: 'vice.clear' });
    expect(await group.leader.next()).toMatchObject({ type: 'vice.updated' });
  });
});

describe('vice-leader in the leader recovery state (#13 AC13)', () => {
  it('restores a valid vice after a restart; ignores a blocked, unknown or leader one', async () => {
    const tokenSecrets = { current: randomBytes(32), source: 'env' as const };
    ts = await startTestServer({ tokenSecrets });
    const group = await createGroupWithMembers(ts, 2);
    await ts.close();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ tokenSecrets, store });
    const vice = group.memberIds[0]!;
    await resumeWith(ts, group.leaderToken, { metadata: {}, viceId: vice });
    expect((await store.get('app-a', group.groupId))?.viceId).toBe(vice);
    const { client } = await resumeWith(ts, group.memberTokens[0]);
    expect(await client.next('vice.changed')).toMatchObject({ isVice: true });
  });

  it('drops a recovered vice that is on the recovered block list or is the leader', async () => {
    for (const pick of ['blocked', 'leader'] as const) {
      const tokenSecrets = { current: randomBytes(32), source: 'env' as const };
      ts = await startTestServer({ tokenSecrets, apps: [{ namespace: 'app-a', apiKey: KEY_A }] });
      const group = await createGroupWithMembers(ts, 1);
      await ts.close();
      const store = new InMemoryGroupStore();
      ts = await startTestServer({ tokenSecrets, store });
      const viceId = pick === 'leader' ? group.leaderId : group.memberIds[0]!;
      const blockList = pick === 'blocked' ? [group.memberIds[0]] : [];
      await resumeWith(ts, group.leaderToken, { metadata: {}, viceId, blockList });
      expect((await store.get('app-a', group.groupId))?.viceId, pick).toBeUndefined();
      await ts.close();
      ts = undefined;
    }
  });
});
