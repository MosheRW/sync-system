import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenSecrets } from '../src/config/token-secret.js';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { type TestServer, startTestServer } from './helpers/test-server.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

describe('blocklist.set while live (#5 AC26)', () => {
  it('removes listed members with group.ended removed and blocks their resumes', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ store });
    const group = await createGroupWithMembers(ts, 2);
    const [blocked, kept] = group.members as [(typeof group.members)[0], (typeof group.members)[0]];
    group.leader.send({ type: 'blocklist.set', reqId: 'b', blockList: [group.memberIds[0]] });
    expect(await group.leader.next('blocklist.ack')).toEqual({ type: 'blocklist.ack', reqId: 'b' });
    expect(await blocked.next('group.ended')).toEqual({
      type: 'group.ended',
      groupId: group.groupId,
      reason: 'removed',
    });
    await kept.expectNoMessage(30);
    expect((await store.get('app-a', group.groupId))?.participantIds).toHaveLength(2);

    expect((await resumeWith(ts, group.memberTokens[0])).reply).toMatchObject({
      code: 'PARTICIPANT_BLOCKED',
      message: 'Participant is blocked',
    });
    // Updates no longer reach the removed member.
    group.leader.send({ type: 'position.update', position: 1 });
    await group.leader.next('position.ack');
    await kept.next('position.updated');
    await blocked.expectNoMessage(30);
  });

  it('ignores the leader’s own ID and duplicates', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ store });
    const group = await createGroupWithMembers(ts, 1);
    const other = randomUUID();
    group.leader.send({ type: 'blocklist.set', blockList: [group.leaderId, other, other] });
    await group.leader.next('blocklist.ack');
    expect((await store.get('app-a', group.groupId))?.blockList).toEqual([other]);
  });

  it('unblocks when the list no longer holds the ID (leaving never blocks)', async () => {
    ts = await startTestServer();
    const group = await createGroupWithMembers(ts, 1);
    group.leader.send({ type: 'blocklist.set', blockList: [group.memberIds[0]] });
    await group.leader.next('blocklist.ack');
    await group.members[0]!.next('group.ended');
    group.leader.send({ type: 'blocklist.set', blockList: [] });
    await group.leader.next('blocklist.ack');
    expect((await resumeWith(ts, group.memberTokens[0])).reply.type).toBe('group.joined');
  });

  it('is leader only', async () => {
    ts = await startTestServer();
    const group = await createGroupWithMembers(ts, 1);
    group.members[0]!.send({ type: 'blocklist.set', blockList: [] });
    expect(await group.members[0]!.next('error')).toMatchObject({ code: 'NOT_LEADER' });
    const outsider = await ts.connectReady();
    outsider.send({ type: 'blocklist.set', blockList: [] });
    expect(await outsider.next('error')).toMatchObject({ code: 'NOT_IN_GROUP' });
    outsider.send({ type: 'blocklist.set', blockList: ['nope'] });
    expect(await outsider.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });
  });
});

describe('block list on leader return and recreation (#5 AC26, L5)', () => {
  it('a leader return with a list removes attached blocked members', async () => {
    ts = await startTestServer();
    const group = await createGroupWithMembers(ts, 2);
    await group.leader.close();
    for (const member of group.members) await member.next('leader.offline');
    await resumeWith(ts, group.leaderToken, { blockList: [group.memberIds[1]] });
    expect(await group.members[1]!.next('group.ended')).toMatchObject({ reason: 'removed' });
    expect(await group.members[0]!.next('leader.online')).toMatchObject({ type: 'leader.online' });
  });

  it('a leader return without a list keeps the server’s list (L5)', async () => {
    ts = await startTestServer();
    // A second member keeps the group in memory while the leader is away.
    const group = await createGroupWithMembers(ts, 2);
    group.leader.send({ type: 'blocklist.set', blockList: [group.memberIds[0]] });
    await group.leader.next('blocklist.ack');
    await group.leader.close();
    await group.members[1]!.next('leader.offline');
    expect((await resumeWith(ts, group.leaderToken)).reply.type).toBe('group.resumed');
    expect((await resumeWith(ts, group.memberTokens[0])).reply).toMatchObject({
      code: 'PARTICIPANT_BLOCKED',
    });
  });

  it('a recreation enforces the list on parked and later members', async () => {
    const tokenSecrets: TokenSecrets = { current: randomBytes(32), source: 'env' };
    ts = await startTestServer({ tokenSecrets });
    const group = await createGroupWithMembers(ts, 2);
    await ts.close();
    ts = await startTestServer({ tokenSecrets });
    const { client: parkedBlocked } = await resumeWith(ts, group.memberTokens[0]);
    await resumeWith(ts, group.leaderToken, {
      metadata: {},
      blockList: [group.memberIds[0], group.memberIds[1]],
    });
    expect(await parkedBlocked.next('error')).toEqual({
      type: 'error',
      code: 'PARTICIPANT_BLOCKED',
      message: 'Participant is blocked',
    });
    expect((await resumeWith(ts, group.memberTokens[1])).reply).toMatchObject({
      code: 'PARTICIPANT_BLOCKED',
    });
  });
});
