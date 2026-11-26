import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { TokenSecretsInput } from '../src/config/token-secret.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { describeRedis, inspector, randomPrefix } from './helpers/redis.js';
import type { TestClient } from './helpers/test-client.js';
import { type TestServer, startTestServer } from './helpers/test-server.js';
import { claimsOf } from './helpers/tokens.js';

const MINUTE = 60_000;
const GRACE_MS = 30_000;

/** The next frame of `type`, skipping any other frame in between. */
async function frameOf<T extends 'leader.granted' | 'error'>(client: TestClient, type: T) {
  for (;;) {
    const message = await client.next();
    if (message.type === type) return message as Extract<typeof message, { type: T }>;
  }
}

describeRedis('restart survival with Redis (#35 AC9-AC15)', () => {
  let inspect: Awaited<ReturnType<typeof inspector>>;
  let prefix: string;
  let secrets: TokenSecretsInput;
  let scheduler: ManualScheduler;
  const servers: TestServer[] = [];

  beforeAll(async () => {
    inspect = await inspector();
  });
  afterAll(() => {
    inspect.close();
  });
  afterEach(async () => {
    for (const ts of servers.splice(0)) await ts.close();
    await inspect.flush(prefix);
  });

  async function start(): Promise<TestServer> {
    const ts = await startTestServer({ redisPrefix: prefix, tokenSecrets: secrets, scheduler });
    servers.push(ts);
    return ts;
  }

  /** A clean stop: the server closes its sockets with 1001 and keeps the stored state. */
  async function stop(ts: TestServer): Promise<void> {
    servers.splice(servers.indexOf(ts), 1);
    await ts.server.close();
  }

  function fresh(): void {
    prefix = randomPrefix();
    secrets = { current: randomBytes(32), source: 'env' };
    scheduler = new ManualScheduler();
  }

  it('a member rejoins at once with the current position (AC9)', async () => {
    fresh();
    const first = await start();
    const group = await createGroupWithMembers(first, 1, { position: { page: 1 } });
    group.leader.send({ type: 'position.update', position: { page: 7 } });
    await group.leader.next('position.ack');
    await stop(first);
    const second = await start();
    expect(second.server.storage()).toEqual({ kind: 'redis', state: 'connected' });
    const { reply } = await resumeWith(second, group.memberTokens[0]);
    expect(reply).toMatchObject({
      type: 'group.joined',
      groupId: group.groupId,
      participantId: group.memberIds[0],
      hasPosition: true,
      position: { page: 7 },
    });
  });

  it('the leader resumes its group: same codes and term, not recreated (AC10)', async () => {
    fresh();
    const first = await start();
    const group = await createGroupWithMembers(first, 0);
    await stop(first);
    const second = await start();
    const { reply } = await resumeWith(second, group.leaderToken, { metadata: { other: 1 } });
    expect(reply).toMatchObject({
      type: 'group.resumed',
      groupId: group.groupId,
      recreated: false,
      superseded: false,
      metadata: { contentId: 'c' },
      codesChanged: true,
      codes: {
        groupCode: group.codes.groupCode,
        doorCode: group.codes.doorCode,
        generation: group.codes.generation,
      },
    });
    const token = (reply as { token: string }).token;
    expect(claimsOf(token).term).toBe(claimsOf(group.leaderToken).term);
  });

  it('a leader online at the stop hands off only a full grace after the restart (AC11)', async () => {
    fresh();
    const first = await start();
    const group = await createGroupWithMembers(first, 1);
    await stop(first);
    scheduler.advance(10 * MINUTE);
    const second = await start();
    const { client: member, reply } = await resumeWith(second, group.memberTokens[0]);
    expect(reply).toMatchObject({ type: 'group.joined', leaderOnline: false });
    scheduler.advance(GRACE_MS - 1000);
    await member.expectNoMessage(50);
    scheduler.advance(1000);
    expect(await member.next('leader.granted')).toMatchObject({ reason: 'handoff_disconnect' });
  });

  it('deadlines that passed while down take effect at the start (AC12)', async () => {
    fresh();
    const first = await start();
    const group = await createGroupWithMembers(first, 1);
    await stop(first);
    // Down past the max session (180 min).
    scheduler.advance(181 * MINUTE);
    const second = await start();
    const { reply } = await resumeWith(second, group.memberTokens[0]);
    expect(reply).toMatchObject({ type: 'error', code: 'GROUP_ENDED' });
    const checker = await second.connectReady();
    checker.send({ type: 'tokens.check', tokens: [group.leaderToken] });
    expect(await checker.next('tokens.result')).toMatchObject({ results: [{ status: 'ended' }] });
    expect(await inspect.keys(`${prefix}:v1:g`)).toEqual([]);
  });

  it('an ended group stays ended: no recreation by an old token (AC13)', async () => {
    fresh();
    const first = await start();
    const group = await createGroupWithMembers(first, 1);
    group.leader.send({ type: 'group.end' });
    await group.leader.next('group.ended');
    await stop(first);
    const second = await start();
    const { reply } = await resumeWith(second, group.leaderToken, { metadata: {} });
    expect(reply).toMatchObject({ type: 'error', code: 'GROUP_ENDED' });
    const checker = await second.connectReady();
    checker.send({ type: 'tokens.check', tokens: [group.leaderToken, group.memberTokens[0]] });
    expect(await checker.next('tokens.result')).toMatchObject({
      results: [{ status: 'ended' }, { status: 'ended' }],
    });
  });

  it('a missing group with a token from this epoch has ended (AC13, epoch fence)', async () => {
    fresh();
    const first = await start();
    const group = await createGroupWithMembers(first, 0);
    await stop(first);
    // The group's keys vanish (as if evicted), the epoch stays.
    for (const key of await inspect.keys(`${prefix}:v1:g`)) await inspect.client.del(key);
    const second = await start();
    const { reply } = await resumeWith(second, group.leaderToken, { metadata: {} });
    expect(reply).toMatchObject({ type: 'error', code: 'GROUP_ENDED' });
  });

  it('after Redis lost its data, the leader token recreates the group (AC14)', async () => {
    fresh();
    const first = await start();
    const group = await createGroupWithMembers(first, 1);
    await stop(first);
    await inspect.flush(prefix);
    const second = await start();
    const { reply: waiting } = await resumeWith(second, group.memberTokens[0]);
    expect(waiting).toMatchObject({ type: 'group.waiting' });
    const { reply } = await resumeWith(second, group.leaderToken, { metadata: { contentId: 'c' } });
    expect(reply).toMatchObject({ type: 'group.resumed', recreated: true, groupId: group.groupId });
  });

  it('a blocked member is refused after a restart before the leader returns (AC15)', async () => {
    fresh();
    const first = await start();
    const group = await createGroupWithMembers(first, 2);
    group.leader.send({ type: 'blocklist.set', blockList: [group.memberIds[0]] });
    await group.leader.next('blocklist.ack');
    await stop(first);
    const second = await start();
    const { reply } = await resumeWith(second, group.memberTokens[0]);
    expect(reply).toMatchObject({ type: 'error', code: 'PARTICIPANT_BLOCKED' });
    const { reply: other } = await resumeWith(second, group.memberTokens[1]);
    expect(other).toMatchObject({ type: 'group.joined' });
    // The leader's list on resume only adds IDs.
    const { reply: leader } = await resumeWith(second, group.leaderToken, { blockList: [] });
    expect(leader).toMatchObject({
      type: 'group.resumed',
      state: { blockList: [group.memberIds[0]] },
    });
  });

  it('a grace running at the stop ends no earlier than the grace after the restart (Q-A3)', async () => {
    fresh();
    const first = await start();
    const group = await createGroupWithMembers(first, 1);
    group.leader.terminate();
    await group.members[0]!.next('leader.offline');
    scheduler.advance(20_000);
    await stop(first);
    scheduler.advance(60_000);
    const second = await start();
    const { client: member } = await resumeWith(second, group.memberTokens[0]);
    scheduler.advance(GRACE_MS - 1000);
    await member.expectNoMessage(50);
    scheduler.advance(1000);
    expect(await member.next('leader.granted')).toMatchObject({ reason: 'handoff_disconnect' });
  });

  it('a take-back leaves the slot empty across a restart; the interim leader is refused (#32 AC4)', async () => {
    fresh();
    const first = await start();
    const group = await createGroupWithMembers(first, 2);
    const [next, other] = group.members as [TestClient, TestClient];
    await group.leader.close();
    await next.next('leader.offline');
    await other.next('leader.offline');
    scheduler.advance(GRACE_MS);
    await next.next('leader.granted');
    const { client: back } = await resumeWith(first, group.leaderToken);
    back.send({ type: 'leader.takeBack' });
    expect(await frameOf(back, 'leader.granted')).toMatchObject({ reason: 'take_back' });
    const lost = await next.next('leader.lost');
    expect(lost).toMatchObject({ reason: 'take_back', takeBackAvailable: false });
    await stop(first);
    const raw = await inspect.client.get(`${prefix}:v1:g:app-a:${group.groupId}`);
    const stored = (JSON.parse(raw!) as { record: Record<string, unknown> }).record;
    expect(stored).toMatchObject({ leaderId: group.leaderId });
    expect(stored).not.toHaveProperty('displacedLeaderId');
    const second = await start();
    const { client: reloaded, reply } = await resumeWith(second, lost.token);
    expect(reply).toMatchObject({
      type: 'group.joined',
      role: 'member',
      participantId: group.memberIds[0],
    });
    reloaded.send({ type: 'leader.takeBack' });
    expect(await frameOf(reloaded, 'error')).toMatchObject({
      code: 'NOT_ALLOWED',
      message: 'Only the displaced leader can take back the lead',
    });
    // The round-trip above flushed anything queued on resume: no offer came.
    expect(reloaded.received.some((f) => f.type === 'takeback.offered')).toBe(false);
    const after = await inspect.client.get(`${prefix}:v1:g:app-a:${group.groupId}`);
    expect((JSON.parse(after!) as { record: { leaderId: string } }).record.leaderId).toBe(
      group.leaderId,
    );
  });

  it('one invalid stored group never blocks the start: that group ends, the others survive (C1)', async () => {
    fresh();
    const first = await start();
    const valid = await createGroupWithMembers(first, 1, { position: { page: 2 } });
    const broken = await createGroupWithMembers(first, 1);
    await stop(first);
    await inspect.client.set(`${prefix}:v1:g:app-a:${broken.groupId}`, '{"v":1,"record":{}}');
    // Without the epoch, only the ended entry can stop a recreation.
    await inspect.client.del(`${prefix}:v1:epoch`);
    const second = await start();
    expect(second.server.storage()).toEqual({ kind: 'redis', state: 'connected' });
    expect(second.logs.find('startup_sweep')).toMatchObject({ groups: 2, invalid: 1 });
    expect(second.logs.find('store_document_invalid')).toBeDefined();
    for (const secret of [broken.groupId, prefix, '"record"']) {
      expect(second.logs.text).not.toContain(secret);
    }
    // The valid group survives.
    const { reply } = await resumeWith(second, valid.memberTokens[0]);
    expect(reply).toMatchObject({
      type: 'group.joined',
      groupId: valid.groupId,
      position: { page: 2 },
    });
    // The invalid one has ended and no token recreates it.
    const { reply: leader } = await resumeWith(second, broken.leaderToken, { metadata: {} });
    expect(leader).toMatchObject({ type: 'error', code: 'GROUP_ENDED' });
    const { reply: member } = await resumeWith(second, broken.memberTokens[0]);
    expect(member).toMatchObject({ type: 'error', code: 'GROUP_ENDED' });
    expect(await inspect.keys(`${prefix}:v1:g:app-a:${broken.groupId}`)).toEqual([]);
    expect(await inspect.keys(`${prefix}:v1:p:app-a:${broken.groupId}`)).toEqual([]);
  });
});
