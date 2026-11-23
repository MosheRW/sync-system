import { randomUUID } from 'node:crypto';
import type { JoinMethod } from '@mosherw/sync-system-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { MEMBER_REMOVALS_PER_GROUP_PER_MINUTE } from '../src/limits/constants.js';
import { createGroupWithMembers, joinByCode, resumeWith } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

const ALL: JoinMethod[] = ['A', 'B', 'C', 'D'];

async function start() {
  const store = new InMemoryGroupStore();
  ts = await startTestServer({
    store,
    scheduler: new ManualScheduler(),
    apps: [{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ALL, maxGroupSize: 100 }],
  });
  return { store, ts };
}

async function remove(leader: TestClient, participantId: string, reqId = 'r') {
  leader.send({ type: 'member.remove', reqId, participantId });
  return leader.next();
}

describe('member.remove (#13 AC32-AC34, RC4, Gate 2 Q-A)', () => {
  it('blocks, detaches with group.ended removed, closes 4004 and rotates every code', async () => {
    const { store } = await start();
    const group = await createGroupWithMembers(ts!, 2, { joinMethods: ['A', 'D'] });
    const [target, kept] = group.members as [TestClient, TestClient];
    group.leader.send({ type: 'qr.issue' });
    const { ticket } = await group.leader.next('qr.ticket');

    expect(await remove(group.leader, group.memberIds[0]!)).toEqual({
      type: 'member.removed',
      reqId: 'r',
      groupId: group.groupId,
      participantId: group.memberIds[0],
      blockList: [group.memberIds[0]],
    });
    const rotated = await group.leader.next('codes.updated');
    expect(rotated).toMatchObject({ reason: 'member_removed' });
    expect(rotated.codes.generation).toBeGreaterThan(group.codes.generation);

    // The removed session: one last group frame, then the socket closes.
    expect(await target.next()).toEqual({
      type: 'group.ended',
      groupId: group.groupId,
      reason: 'removed',
    });
    expect((await target.closed()).code).toBe(4004);
    expect(target.pending).toBe(0);

    // Nobody else is told who was removed; the group goes on.
    group.leader.send({ type: 'position.update', position: 2 });
    await group.leader.next('position.ack');
    expect(await kept.next('position.updated')).toMatchObject({ position: 2 });
    const record = await store.get('app-a', group.groupId);
    expect(record?.roster.map((e) => e.pid)).not.toContain(group.memberIds[0]);

    // No way back: token, old codes, old QR ticket.
    expect((await resumeWith(ts!, group.memberTokens[0])).reply).toMatchObject({
      code: 'PARTICIPANT_BLOCKED',
    });
    expect((await joinByCode(ts!, group)).reply).toMatchObject({ code: 'CODE_NOT_FOUND' });
    const qr = await ts!.connectReady();
    qr.send({ type: 'group.joinByQr', ticket });
    expect(await qr.next('error')).toMatchObject({ code: 'QR_INVALID' });
    // The new codes work for a new person.
    expect((await joinByCode(ts!, rotated)).reply.type).toBe('group.joined');
  });

  it('removes an offline roster member, which has no socket to close', async () => {
    const { store } = await start();
    const group = await createGroupWithMembers(ts!, 1);
    await group.members[0]!.close();
    await waitUntil(
      async () => (await store.get('app-a', group.groupId))?.roster[1]?.connected === false,
    );
    expect(await remove(group.leader, group.memberIds[0]!)).toMatchObject({
      type: 'member.removed',
    });
    expect((await resumeWith(ts!, group.memberTokens[0])).reply).toMatchObject({
      code: 'PARTICIPANT_BLOCKED',
    });
  });

  it('refuses the leader (NOT_ALLOWED) and unknown IDs (PARTICIPANT_NOT_FOUND)', async () => {
    await start();
    const group = await createGroupWithMembers(ts!, 1);
    expect(await remove(group.leader, group.leaderId)).toMatchObject({
      code: 'NOT_ALLOWED',
      message: 'This participant cannot be removed',
    });
    expect(await remove(group.leader, randomUUID())).toEqual({
      type: 'error',
      reqId: 'r',
      code: 'PARTICIPANT_NOT_FOUND',
      message: 'Participant not found',
    });
    group.members[0]!.send({ type: 'member.remove', participantId: group.leaderId });
    expect(await group.members[0]!.next('error')).toMatchObject({ code: 'NOT_LEADER' });
  });

  it('clears the vice when the vice is removed', async () => {
    const { store } = await start();
    const group = await createGroupWithMembers(ts!, 1);
    group.leader.send({ type: 'vice.set', participantId: group.memberIds[0] });
    await group.leader.next('vice.updated');
    await remove(group.leader, group.memberIds[0]!);
    expect((await store.get('app-a', group.groupId))?.viceId).toBeUndefined();
  });

  it('answers BLOCK_LIST_FULL with 256 entries, without evicting or removing', async () => {
    const { store } = await start();
    const group = await createGroupWithMembers(ts!, 1);
    const full = Array.from({ length: 256 }, () => randomUUID());
    group.leader.send({ type: 'blocklist.set', blockList: full });
    await group.leader.next('blocklist.ack');
    expect(await remove(group.leader, group.memberIds[0]!)).toMatchObject({
      code: 'BLOCK_LIST_FULL',
      details: { maxBlockList: 256 },
    });
    await group.members[0]!.expectNoMessage(30);
    expect((await store.get('app-a', group.groupId))?.blockList).toEqual(full);
  });

  it('rate-limits removals per group; refused requests spend nothing (RC2)', async () => {
    await start();
    const group = await createGroupWithMembers(ts!, MEMBER_REMOVALS_PER_GROUP_PER_MINUTE + 1);
    await remove(group.leader, randomUUID());
    await remove(group.leader, group.leaderId);
    for (let i = 0; i < MEMBER_REMOVALS_PER_GROUP_PER_MINUTE; i++) {
      expect(await remove(group.leader, group.memberIds[i]!)).toMatchObject({
        type: 'member.removed',
      });
      await group.leader.next('codes.updated');
    }
    expect(
      await remove(group.leader, group.memberIds[MEMBER_REMOVALS_PER_GROUP_PER_MINUTE]!),
    ).toMatchObject({ code: 'RATE_LIMITED', message: 'Too many member removals' });
  });
});
