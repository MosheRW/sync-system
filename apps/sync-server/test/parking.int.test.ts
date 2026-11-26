import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenSecretsInput } from '../src/config/token-secret.js';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { type TestGroup, createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import {
  KEY_A,
  type TestAppInput,
  type TestServer,
  startTestServer,
} from './helpers/test-server.js';
import { claimsOf } from './helpers/tokens.js';
import { sleep, waitUntil } from './helpers/wait.js';

const MINUTE = 60_000;

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

/** A group with members on a first server instance, then a restarted instance. */
async function restarted(
  memberCount: number,
  options: { apps?: TestAppInput[]; scheduler?: ManualScheduler } = {},
): Promise<{ group: TestGroup; store: InMemoryGroupStore; ts: TestServer }> {
  const tokenSecrets: TokenSecretsInput = { current: randomBytes(32), source: 'env' };
  const extra = {
    tokenSecrets,
    ...(options.apps ? { apps: options.apps } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  };
  ts = await startTestServer(extra);
  const group = await createGroupWithMembers(ts, memberCount, { position: { page: 3 } });
  await ts.close();
  const store = new InMemoryGroupStore();
  ts = await startTestServer({ ...extra, store });
  return { group, store, ts };
}

describe('members waiting for their leader (#5 AC25)', () => {
  it('parks members, then admits them when the leader recreates the group', async () => {
    const { group, ts } = await restarted(2);
    const waiting = [];
    for (const [i, token] of group.memberTokens.entries()) {
      const { client, reply } = await resumeWith(ts, token, { reqId: `w${i}` });
      expect(reply).toEqual({ type: 'group.waiting', reqId: `w${i}`, groupId: group.groupId });
      waiting.push(client);
    }

    const { client: leader } = await resumeWith(ts, group.leaderToken, {
      metadata: { m: 1 },
      position: { page: 9 },
    });
    for (const [i, member] of waiting.entries()) {
      const joined = await member.next('group.joined');
      expect(joined).toEqual({
        type: 'group.joined',
        groupId: group.groupId,
        participantId: group.memberIds[i],
        role: 'member',
        displayName: expect.any(String) as string,
        generated: true,
        locked: false,
        metadata: { m: 1 },
        token: expect.any(String) as string,
        leaderOnline: true,
        hasPosition: true,
        position: { page: 9 },
      });
      expect(claimsOf(joined.token).pid).toBe(group.memberIds[i]);
    }
    leader.send({ type: 'position.update', position: { page: 10 } });
    await leader.next('position.ack');
    for (const member of waiting) {
      expect(await member.next('position.updated')).toMatchObject({ position: { page: 10 } });
    }
  });

  it('answers ALREADY_IN_GROUP to a second resume or a create while parked', async () => {
    const { group, ts } = await restarted(1);
    const { client } = await resumeWith(ts, group.memberTokens[0]);
    client.send({ type: 'group.resume', token: group.memberTokens[0] });
    expect(await client.next('error')).toMatchObject({ code: 'ALREADY_IN_GROUP' });
    client.send({ type: 'group.create', metadata: {} });
    expect(await client.next('error')).toMatchObject({ code: 'ALREADY_IN_GROUP' });
    client.send({ type: 'group.end' });
    expect(await client.next('error')).toMatchObject({
      code: 'NOT_LEADER',
      message: 'Only the leader can end the group',
    });
    client.send({ type: 'blocklist.set', blockList: [] });
    expect(await client.next('error')).toMatchObject({
      code: 'NOT_LEADER',
      message: 'Only the leader can set the block list',
    });
    // #13 D1: a parked session is refused like every non-leader.
    client.send({ type: 'position.update', position: 1 });
    expect(await client.next('error')).toMatchObject({
      code: 'NOT_LEADER',
      message: 'Only the leader can update the position',
    });
  });

  it('stops waiting on group.leave and on disconnect', async () => {
    const { group, ts } = await restarted(2);
    const { client: leaving } = await resumeWith(ts, group.memberTokens[0]);
    const { client: closing } = await resumeWith(ts, group.memberTokens[1]);
    leaving.send({ type: 'group.leave', reqId: 'l' });
    expect(await leaving.next('group.left')).toEqual({
      type: 'group.left',
      reqId: 'l',
      groupId: group.groupId,
    });
    await closing.close();
    await sleep(30);
    await resumeWith(ts, group.leaderToken, { metadata: {} });
    await leaving.expectNoMessage(50);
  });

  it('sends GROUP_FULL to parked members over the size limit', async () => {
    const tokenSecrets: TokenSecretsInput = { current: randomBytes(32), source: 'env' };
    ts = await startTestServer({ tokenSecrets });
    const group = await createGroupWithMembers(ts, 2);
    await ts.close();
    // The restarted server allows 2 participants: the leader and one member.
    ts = await startTestServer({
      tokenSecrets,
      apps: [{ namespace: 'app-a', apiKey: KEY_A, maxGroupSize: 2 }],
    });
    const { client: first } = await resumeWith(ts, group.memberTokens[0]);
    const { client: second } = await resumeWith(ts, group.memberTokens[1]);
    await resumeWith(ts, group.leaderToken, { metadata: {} });
    expect((await first.next('group.joined')).participantId).toBe(group.memberIds[0]);
    expect(await second.next('error')).toEqual({
      type: 'error',
      code: 'GROUP_FULL',
      message: 'Group is full',
      details: { maxGroupSize: 2 },
    });
    // Not parked any more and not in the group.
    second.send({ type: 'group.create', metadata: {} });
    expect((await second.next('group.created')).role).toBe('leader');
  });

  it('releases a parked member after the leader window with leader_timeout', async () => {
    const scheduler = new ManualScheduler();
    const { group, ts } = await restarted(1, { scheduler });
    const { client } = await resumeWith(ts, group.memberTokens[0]);
    scheduler.advance(20 * MINUTE + 300_000 - 1);
    await client.expectNoMessage(30);
    scheduler.advance(1);
    expect(await client.next('group.ended')).toEqual({
      type: 'group.ended',
      groupId: group.groupId,
      reason: 'leader_timeout',
    });
    // Free again.
    client.send({ type: 'group.create', metadata: {} });
    expect((await client.next('group.created')).role).toBe('leader');
  });

  it('releases with max_session when the group’s max session comes first', async () => {
    const scheduler = new ManualScheduler();
    const apps = [{ namespace: 'app-a', apiKey: KEY_A, maxSessionMinutes: 10 }];
    const { group, ts } = await restarted(1, { scheduler, apps });
    const created = claimsOf(group.leaderToken).gct;
    const { client } = await resumeWith(ts, group.memberTokens[0]);
    scheduler.advanceTo(created + 10 * MINUTE);
    expect((await client.next('group.ended')).reason).toBe('max_session');
  });
});

describe('one parked session per participant (#5 M5, R8)', () => {
  it('keeps the newest of three connections with the same token; one member admitted', async () => {
    const { group, store, ts } = await restarted(1);
    const connections = [];
    for (let i = 0; i < 3; i++) {
      const { client, reply } = await resumeWith(ts, group.memberTokens[0]);
      expect(reply.type).toBe('group.waiting');
      connections.push(client);
    }
    for (const older of connections.slice(0, 2)) {
      expect(await older.next('group.ended')).toMatchObject({ reason: 'replaced' });
    }
    await resumeWith(ts, group.leaderToken, { metadata: {} });
    expect((await connections[2]!.next('group.joined')).participantId).toBe(group.memberIds[0]);
    for (const older of connections.slice(0, 2)) await older.expectNoMessage(30);
    expect((await store.get('app-a', group.groupId))?.participantIds).toHaveLength(2);

    // The connected count stays right after each disconnect.
    for (const older of connections.slice(0, 2)) await older.close();
    await sleep(30);
    expect((await store.get('app-a', group.groupId))?.participantIds).toHaveLength(2);
    await connections[2]!.close();
    await waitUntil(
      async () => (await store.get('app-a', group.groupId))?.participantIds.length === 1,
    );
  });

  it('leaves no parking timer behind on server close', async () => {
    const scheduler = new ManualScheduler();
    const { group, ts: server } = await restarted(1, { scheduler });
    await resumeWith(server, group.memberTokens[0]);
    expect(scheduler.pending).toBe(1);
    await server.close();
    ts = undefined;
    expect(scheduler.pending).toBe(0);
  });
});
