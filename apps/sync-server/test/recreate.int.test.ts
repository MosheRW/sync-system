import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenSecrets } from '../src/config/token-secret.js';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';
import { claimsOf } from './helpers/tokens.js';
import { waitUntil } from './helpers/wait.js';

const MINUTE = 60_000;

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

function secrets(): TokenSecrets {
  return { current: randomBytes(32), source: 'env' };
}

describe('recreation after a restart (#5 AC23)', () => {
  it('recreates the group with the same ID, creation time and leader; members rejoin', async () => {
    const tokenSecrets = secrets();
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ tokenSecrets, scheduler });
    const group = await createGroupWithMembers(ts, 1, { metadata: { book: 1 }, position: 1 });
    group.leader.send({ type: 'position.update', position: { page: 7 } });
    await group.leader.next('position.ack');
    await ts.close();

    // New process: new store, same secret. Nothing is in memory.
    const store = new InMemoryGroupStore();
    scheduler.advance(2 * MINUTE);
    ts = await startTestServer({ tokenSecrets, scheduler, store });
    expect(store.size).toBe(0);

    const { client: leader, reply } = await resumeWith(ts, group.leaderToken, {
      reqId: 'r',
      metadata: { book: 1 },
      position: { page: 7 },
      blockList: [],
    });
    expect(reply).toEqual({
      type: 'group.resumed',
      reqId: 'r',
      groupId: group.groupId,
      participantId: group.leaderId,
      role: 'leader',
      displayName: expect.any(String) as string,
      generated: true,
      metadata: { book: 1 },
      hasPosition: true,
      position: { page: 7 },
      token: expect.any(String) as string,
      recreated: true,
      // No blob was sent: a full new set of codes (#10 AC33).
      joinMethods: ['A', 'D'],
      codes: expect.any(Object) as object,
      codesChanged: true,
    });
    if (reply.type !== 'group.resumed') throw new Error('expected resumed');
    const fresh = claimsOf(reply.token);
    expect(fresh).toMatchObject({
      gid: group.groupId,
      pid: group.leaderId,
      gct: claimsOf(group.leaderToken).gct,
      lat: scheduler.now(),
    });
    expect(await store.get('app-a', group.groupId)).toMatchObject({
      createdAt: claimsOf(group.leaderToken).gct,
      leaderId: group.leaderId,
      leaderOnline: true,
    });

    const { client: member, reply: joined } = await resumeWith(ts, group.memberTokens[0]);
    expect(joined).toMatchObject({
      type: 'group.joined',
      groupId: group.groupId,
      participantId: group.memberIds[0],
      position: { page: 7 },
    });
    leader.send({ type: 'position.update', position: { page: 8 } });
    await leader.next('position.ack');
    expect(await member.next('position.updated')).toMatchObject({ position: { page: 8 } });
  });

  it('accepts a recreation without a position', async () => {
    const tokenSecrets = secrets();
    ts = await startTestServer({ tokenSecrets });
    const group = await createGroupWithMembers(ts, 0);
    await ts.close();
    ts = await startTestServer({ tokenSecrets });
    const { reply } = await resumeWith(ts, group.leaderToken, { metadata: {} });
    expect(reply).toMatchObject({ type: 'group.resumed', recreated: true, hasPosition: false });
  });

  it('keeps the original max-session deadline (gct), not a new one', async () => {
    const tokenSecrets = secrets();
    const scheduler = new ManualScheduler();
    const apps = [{ namespace: 'app-a', apiKey: KEY_A, maxSessionMinutes: 30 }];
    ts = await startTestServer({ tokenSecrets, scheduler, apps });
    const created = scheduler.now();
    const group = await createGroupWithMembers(ts, 0);
    await ts.close();
    scheduler.advance(10 * MINUTE);
    ts = await startTestServer({ tokenSecrets, scheduler, apps });
    const { client } = await resumeWith(ts, group.leaderToken, { metadata: {} });
    scheduler.advanceTo(created + 30 * MINUTE);
    expect(await client.next('group.ended')).toMatchObject({ reason: 'max_session' });
  });

  it('stores a deduplicated block list without the leader’s own ID', async () => {
    const tokenSecrets = secrets();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ tokenSecrets });
    const group = await createGroupWithMembers(ts, 0);
    await ts.close();
    ts = await startTestServer({ tokenSecrets, store });
    const blocked = randomUUID();
    await resumeWith(ts, group.leaderToken, {
      metadata: {},
      blockList: [blocked, blocked, group.leaderId],
    });
    expect((await store.get('app-a', group.groupId))?.blockList).toEqual([blocked]);
  });
});

describe('recreation request rules (#5 AC24)', () => {
  /** A group on a first instance, then a restarted one (#13 D15: no recreation in-process). */
  async function droppedGroup() {
    const tokenSecrets = secrets();
    const apps = [{ namespace: 'app-a', apiKey: KEY_A, maxMessageBytes: 16384 }];
    ts = await startTestServer({ tokenSecrets, apps });
    const group = await createGroupWithMembers(ts, 0);
    await ts.close();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ tokenSecrets, apps, store });
    return { group, store, ts };
  }

  it('requires metadata', async () => {
    const { group, store, ts } = await droppedGroup();
    const { reply } = await resumeWith(ts, group.leaderToken, { reqId: 'm' });
    expect(reply).toMatchObject({ type: 'error', reqId: 'm', code: 'INVALID_MESSAGE' });
    expect(store.size).toBe(0);
  });

  it('size-checks metadata and position like group.create', async () => {
    const { group, store, ts } = await droppedGroup();
    const big = { blob: 'x'.repeat(16384) };
    expect((await resumeWith(ts, group.leaderToken, { metadata: big })).reply).toMatchObject({
      code: 'MESSAGE_TOO_LARGE',
      details: { field: 'metadata', limitBytes: 16384 },
    });
    expect(
      (await resumeWith(ts, group.leaderToken, { metadata: {}, position: big })).reply,
    ).toMatchObject({ code: 'MESSAGE_TOO_LARGE', details: { field: 'position' } });
    expect(store.size).toBe(0);
  });

  it('refuses a block list over 256 IDs or with a malformed ID', async () => {
    const { group, ts } = await droppedGroup();
    const ids = Array.from({ length: 257 }, () => randomUUID());
    for (const blockList of [ids, ['not-a-uuid'], 'x']) {
      const { reply } = await resumeWith(ts, group.leaderToken, { metadata: {}, blockList });
      expect(reply).toMatchObject({ code: 'INVALID_MESSAGE' });
    }
  });

  it('fits 256 IDs plus metadata and position at the ceiling in one frame', async () => {
    const { group, store, ts } = await droppedGroup();
    // Each serializes to exactly 16384 bytes.
    const atLimit = { s: 'y'.repeat(16384 - '{"s":""}'.length) };
    const blockList = Array.from({ length: 256 }, () => randomUUID());
    const { reply } = await resumeWith(ts, group.leaderToken, {
      metadata: atLimit,
      position: atLimit,
      blockList,
    });
    expect(reply).toMatchObject({ type: 'group.resumed', recreated: true });
    expect((await store.get('app-a', group.groupId))?.blockList).toHaveLength(256);
  });
});

describe('one group per token (#5 AC27, AC28)', () => {
  it('two concurrent resumes with one leader token make one group; the first is replaced', async () => {
    const tokenSecrets = secrets();
    ts = await startTestServer({ tokenSecrets });
    const group = await createGroupWithMembers(ts, 0);
    await ts.close();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ tokenSecrets, store });

    const a = await ts.connectReady();
    const b = await ts.connectReady();
    a.send({ type: 'group.resume', token: group.leaderToken, metadata: { from: 'a' } });
    b.send({ type: 'group.resume', token: group.leaderToken, metadata: { from: 'b' } });
    const ra = await a.next('group.resumed');
    const rb = await b.next('group.resumed');
    expect([ra.recreated, rb.recreated].sort()).toEqual([false, true]);
    expect(store.size).toBe(1);
    const first = ra.recreated ? a : b;
    expect(await first.next('group.ended')).toMatchObject({ reason: 'replaced' });
    // The second took the record-present path: the first one's metadata stays.
    const kept = ra.recreated ? { from: 'a' } : { from: 'b' };
    expect((ra.recreated ? rb : ra).metadata).toEqual(kept);
  });

  it('cannot recreate a group that ended in this process', async () => {
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ store });
    const group = await createGroupWithMembers(ts, 0);
    group.leader.send({ type: 'group.end' });
    await group.leader.next('group.ended');
    const { reply } = await resumeWith(ts, group.leaderToken, { metadata: {} });
    expect(reply).toMatchObject({ code: 'GROUP_ENDED' });
    expect(store.size).toBe(0);
  });

  it('"resume later" after a restart: recreated within the window (AC28)', async () => {
    const tokenSecrets = secrets();
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ tokenSecrets, scheduler });
    const group = await createGroupWithMembers(ts, 0, { position: 'p' });
    await ts.close();
    scheduler.advance(20 * MINUTE);
    ts = await startTestServer({ tokenSecrets, scheduler, store: new InMemoryGroupStore() });
    const { reply } = await resumeWith(ts, group.leaderToken, { metadata: {}, position: 'p' });
    expect(reply).toMatchObject({
      type: 'group.resumed',
      groupId: group.groupId,
      recreated: true,
      position: 'p',
    });
  });

  it('an emptied group ends and is never recreated in the same process (#13 D15)', async () => {
    const scheduler = new ManualScheduler();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ scheduler, store });
    const group = await createGroupWithMembers(ts, 0, { position: 'p' });
    await group.leader.close();
    await waitUntil(() => store.size === 0);
    scheduler.advance(MINUTE);
    const { reply } = await resumeWith(ts, group.leaderToken, { metadata: {}, position: 'p' });
    expect(reply).toMatchObject({ type: 'error', code: 'GROUP_ENDED' });
    expect(store.size).toBe(0);
  });

  it('a new instance holds no group until a leader resumes (AC11)', async () => {
    const tokenSecrets = secrets();
    ts = await startTestServer({ tokenSecrets });
    const group = await createGroupWithMembers(ts, 1);
    await ts.close();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ tokenSecrets, store });
    const member = await ts.connectReady();
    member.send({ type: 'group.joinByCode', ...group.join });
    expect(await member.next('error')).toMatchObject({ code: 'CODE_NOT_FOUND' });
    expect(store.size).toBe(0);
  });
});
