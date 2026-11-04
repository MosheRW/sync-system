import { JOIN_REQUEST_ID_PATTERN, type JoinMethod } from '@sync-system/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { codesOf } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import {
  KEY_A,
  type TestAppInput,
  type TestServer,
  startTestServer,
} from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

const ALL: JoinMethod[] = ['A', 'B', 'C', 'D'];
const TIMEOUT_MS = 120_000;

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

async function start(app: Partial<TestAppInput> = {}) {
  const scheduler = new ManualScheduler();
  const store = new InMemoryGroupStore();
  ts = await startTestServer({
    scheduler,
    store,
    apps: [{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ALL, ...app }],
  });
  return { server: ts, scheduler, store };
}

async function bGroup(server: TestServer) {
  const leader = await server.connectReady();
  leader.send({ type: 'group.create', metadata: { m: 1 }, joinMethods: ['B'] });
  const created = await leader.next('group.created');
  return { leader, created, join: codesOf(created.codes) };
}

/** A new joiner that asks to join; returns it with its join.pending reply. */
async function ask(server: TestServer, joinCode: string, displayName?: string) {
  const joiner = await server.connectReady();
  const message: Record<string, unknown> = { type: 'group.joinByCode', reqId: 'ask', joinCode };
  if (displayName !== undefined) message.displayName = displayName;
  joiner.send(message);
  const pending = await joiner.next('join.pending');
  return { joiner, pending };
}

async function nextNonRefresh(client: TestClient) {
  let message = await client.next();
  while (message.type === 'token.refreshed') message = await client.next();
  return message;
}

describe('method B requests (#10 AC19, AC20)', () => {
  it('queues the joiner and tells the leader, with the display name', async () => {
    const { server } = await start();
    const { leader, created, join } = await bGroup(server);
    const { pending } = await ask(server, join.joinCode, '  Dana  ');
    expect(pending).toEqual({
      type: 'join.pending',
      reqId: 'ask',
      requestId: expect.stringMatching(JOIN_REQUEST_ID_PATTERN) as string,
      timeoutMs: TIMEOUT_MS,
    });
    expect(JSON.stringify(pending)).not.toContain(created.groupId);
    expect(await leader.next('join.requested')).toEqual({
      type: 'join.requested',
      groupId: created.groupId,
      requestId: pending.requestId,
      expiresInMs: TIMEOUT_MS,
      displayName: 'Dana',
    });
  });

  it('omits a missing display name and accepts emoji names (R9)', async () => {
    const { server } = await start();
    const { leader, join } = await bGroup(server);
    await ask(server, join.joinCode);
    expect('displayName' in (await leader.next('join.requested'))).toBe(false);
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    await ask(server, join.joinCode, family.repeat(4));
    expect((await leader.next('join.requested')).displayName).toBe(family.repeat(4));
  });

  it('rejects bad display names with INVALID_MESSAGE (AC20, R9, B2)', async () => {
    const { server } = await start();
    const { join } = await bGroup(server);
    const bad = [
      '',
      '   ',
      'x'.repeat(33),
      `a${String.fromCharCode(0)}b`,
      `a${String.fromCharCode(0x202e)}b`,
      `a${String.fromCharCode(0xd800)}`,
      `a${String.fromCharCode(0x200b)}b`,
      `a${String.fromCharCode(0xfeff)}b`,
      // Blank or invisible by Unicode property (#10 B2).
      String.fromCodePoint(0x2800),
      String.fromCodePoint(0x1160),
      String.fromCodePoint(0x034f),
      String.fromCodePoint(0xfe0f),
      String.fromCodePoint(0xe0067, 0xe007f),
      `a${String.fromCodePoint(0x200c)}b`,
      `a${String.fromCodePoint(0xfff9)}b`,
    ];
    // A fresh connection per name, so the per-connection attempt budget
    // never answers first.
    for (const displayName of bad) {
      const joiner = await server.connectReady();
      joiner.send({ type: 'group.joinByCode', joinCode: join.joinCode, displayName });
      expect(await joiner.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });
      await joiner.close();
    }
  });

  it('waits for a frozen group leader and re-sends the request on return (AC17, AC21, AC34)', async () => {
    const { server, scheduler } = await start();
    const { leader, created, join } = await bGroup(server);
    const member = await server.connectReady();
    member.send({ type: 'group.joinByCode', joinCode: join.joinCode });
    const firstPending = await member.next('join.pending');
    leader.send({ type: 'join.approve', requestId: firstPending.requestId });
    await leader.next('join.requested');
    await leader.next('join.decided');
    await member.next('group.joined');
    await leader.close();
    await member.next('leader.offline');

    const { joiner, pending } = await ask(server, join.joinCode, 'Dana');
    scheduler.advance(20_000);
    const back = await server.connectReady();
    back.send({ type: 'group.resume', token: created.token });
    expect((await back.next('group.resumed')).groupId).toBe(created.groupId);
    expect(await nextNonRefresh(back)).toEqual({
      type: 'join.requested',
      groupId: created.groupId,
      requestId: pending.requestId,
      expiresInMs: TIMEOUT_MS - 20_000,
      displayName: 'Dana',
    });
    back.send({ type: 'join.approve', requestId: pending.requestId });
    expect(await back.next('join.decided')).toMatchObject({ outcome: 'admitted' });
    expect(await joiner.next('group.joined')).toMatchObject({ leaderOnline: true });
  });
});

describe('approve, deny, timeout, cancel (#10 AC21)', () => {
  it('admits on approve: unsolicited group.joined to the joiner, join.decided to the leader', async () => {
    const { server, scheduler, store } = await start();
    const { leader, created, join } = await bGroup(server);
    const { joiner, pending } = await ask(server, join.joinCode);
    await leader.next('join.requested');
    leader.send({ type: 'join.approve', reqId: 'ok', requestId: pending.requestId });
    expect(await leader.next('join.decided')).toEqual({
      type: 'join.decided',
      reqId: 'ok',
      requestId: pending.requestId,
      outcome: 'admitted',
    });
    const joined = await joiner.next('group.joined');
    expect(joined.reqId).toBeUndefined();
    expect(joined).toMatchObject({ groupId: created.groupId, role: 'member', metadata: { m: 1 } });
    expect((await store.get('app-a', created.groupId))?.participantIds).toHaveLength(2);
    // Only the max-session and refresh timers remain; the deadline timer is gone.
    scheduler.advance(TIMEOUT_MS);
    await joiner.expectNoMessage(30);
    // A second approve finds nothing.
    leader.send({ type: 'join.approve', requestId: pending.requestId });
    expect(await nextNonRefresh(leader)).toMatchObject({ code: 'JOIN_REQUEST_NOT_FOUND' });
  });

  it('answers GROUP_FULL when the group filled up meanwhile', async () => {
    const { server } = await start({ maxGroupSize: 2 });
    const { leader, join } = await bGroup(server);
    const first = await ask(server, join.joinCode);
    const second = await ask(server, join.joinCode);
    await leader.next('join.requested');
    await leader.next('join.requested');
    leader.send({ type: 'join.approve', requestId: first.pending.requestId });
    expect((await leader.next('join.decided')).outcome).toBe('admitted');
    leader.send({ type: 'join.approve', requestId: second.pending.requestId });
    expect((await leader.next('join.decided')).outcome).toBe('group_full');
    expect(await second.joiner.next('error')).toEqual({
      type: 'error',
      code: 'GROUP_FULL',
      message: 'Group is full',
      details: { maxGroupSize: 2 },
    });
  });

  it('denies: JOIN_DENIED to the joiner, which may ask again', async () => {
    const { server } = await start();
    const { leader, join } = await bGroup(server);
    const { joiner, pending } = await ask(server, join.joinCode);
    await leader.next('join.requested');
    leader.send({ type: 'join.deny', requestId: pending.requestId });
    expect(await leader.next('join.decided')).toMatchObject({ outcome: 'denied' });
    expect(await joiner.next('error')).toEqual({
      type: 'error',
      code: 'JOIN_DENIED',
      message: 'The leader denied the join request',
    });
    joiner.send({ type: 'group.joinByCode', joinCode: join.joinCode });
    expect((await joiner.next('join.pending')).requestId).not.toBe(pending.requestId);
  });

  it('times out after approvalTimeoutSeconds', async () => {
    const { server, scheduler } = await start({ approvalTimeoutSeconds: 30 });
    const { leader, created, join } = await bGroup(server);
    const { joiner, pending } = await ask(server, join.joinCode);
    expect(pending.timeoutMs).toBe(30_000);
    await leader.next('join.requested');
    scheduler.advance(29_999);
    await joiner.expectNoMessage(30);
    scheduler.advance(1);
    expect(await joiner.next('error')).toEqual({
      type: 'error',
      code: 'APPROVAL_TIMEOUT',
      message: 'The join request was not approved in time',
    });
    expect(await nextNonRefresh(leader)).toEqual({
      type: 'join.withdrawn',
      groupId: created.groupId,
      requestId: pending.requestId,
      reason: 'timeout',
    });
    leader.send({ type: 'join.deny', requestId: pending.requestId });
    expect(await nextNonRefresh(leader)).toMatchObject({ code: 'JOIN_REQUEST_NOT_FOUND' });
  });

  it('lets the joiner cancel; the leader gets join.withdrawn cancelled', async () => {
    const { server, scheduler } = await start();
    const { leader, created, join } = await bGroup(server);
    const { joiner, pending } = await ask(server, join.joinCode);
    await leader.next('join.requested');
    joiner.send({ type: 'join.cancel', reqId: 'c' });
    expect(await joiner.next('join.cancelled')).toEqual({
      type: 'join.cancelled',
      reqId: 'c',
      requestId: pending.requestId,
    });
    expect(await leader.next('join.withdrawn')).toMatchObject({
      groupId: created.groupId,
      reason: 'cancelled',
    });
    joiner.send({ type: 'join.cancel', reqId: 'c2' });
    expect(await joiner.next('error')).toMatchObject({
      code: 'JOIN_REQUEST_NOT_FOUND',
      reqId: 'c2',
    });
    leader.send({ type: 'join.approve', requestId: pending.requestId });
    expect(await leader.next('error')).toMatchObject({ code: 'JOIN_REQUEST_NOT_FOUND' });
    scheduler.advance(TIMEOUT_MS);
    await joiner.expectNoMessage(30);
  });

  it('withdraws on joiner disconnect', async () => {
    const { server, store } = await start();
    const { leader, created, join } = await bGroup(server);
    const { joiner, pending } = await ask(server, join.joinCode);
    await leader.next('join.requested');
    await joiner.close();
    expect(await leader.next('join.withdrawn')).toEqual({
      type: 'join.withdrawn',
      groupId: created.groupId,
      requestId: pending.requestId,
      reason: 'disconnected',
    });
    leader.send({ type: 'join.approve', requestId: pending.requestId });
    expect(await leader.next('error')).toMatchObject({ code: 'JOIN_REQUEST_NOT_FOUND' });
    expect((await store.get('app-a', created.groupId))?.participantIds).toHaveLength(1);
  });
});

describe('who may decide (#10 AC21, R12)', () => {
  it('refuses members and other groups with distinct answers', async () => {
    const { server } = await start();
    const { leader, join } = await bGroup(server);
    const other = await bGroup(server);
    const { pending } = await ask(server, join.joinCode);
    await leader.next('join.requested');

    // A member of the group.
    const { joiner: member, pending: memberPending } = await ask(server, join.joinCode);
    await leader.next('join.requested');
    leader.send({ type: 'join.approve', requestId: memberPending.requestId });
    await leader.next('join.decided');
    await member.next('group.joined');
    member.send({ type: 'join.approve', reqId: 'm', requestId: pending.requestId });
    expect(await member.next('error')).toEqual({
      type: 'error',
      reqId: 'm',
      code: 'NOT_LEADER',
      message: 'Only the leader can approve join requests',
    });
    member.send({ type: 'join.deny', requestId: pending.requestId });
    expect(await member.next('error')).toMatchObject({
      message: 'Only the leader can deny join requests',
    });

    // The leader of another group cannot settle this group's request.
    other.leader.send({ type: 'join.approve', requestId: pending.requestId });
    expect(await other.leader.next('error')).toMatchObject({ code: 'JOIN_REQUEST_NOT_FOUND' });

    const outsider = await server.connectReady();
    outsider.send({ type: 'join.deny', requestId: pending.requestId });
    expect(await outsider.next('error')).toMatchObject({ code: 'NOT_IN_GROUP' });
    outsider.send({ type: 'join.approve', requestId: 'not-an-id' });
    expect(await outsider.next('error')).toMatchObject({ code: 'INVALID_MESSAGE' });
  });
});

describe('limits and group end (#10 AC22, D9)', () => {
  it('holds 10 pending requests per group and one per connection', async () => {
    const { server } = await start();
    const { join } = await bGroup(server);
    const joiners: TestClient[] = [];
    for (let i = 0; i < 10; i++) joiners.push((await ask(server, join.joinCode)).joiner);
    const eleventh = await server.connectReady();
    eleventh.send({ type: 'group.joinByCode', joinCode: join.joinCode });
    expect(await eleventh.next('error')).toEqual({
      type: 'error',
      code: 'APPROVAL_QUEUE_FULL',
      message: 'Too many pending join requests for this group',
      details: { maxPending: 10 },
    });
    // A pending connection is busy for every join, create and resume.
    const first = joiners[0]!;
    for (const message of [
      { type: 'group.joinByCode', joinCode: join.joinCode },
      { type: 'group.create', metadata: {} },
    ]) {
      first.send(message);
      expect(await first.next('error')).toMatchObject({ code: 'ALREADY_IN_GROUP' });
    }
  });

  it('tells every pending joiner GROUP_ENDED, without a group ID, when the group ends', async () => {
    const { server, scheduler, store } = await start();
    const { leader, created, join } = await bGroup(server);
    const asks = [await ask(server, join.joinCode), await ask(server, join.joinCode)];
    leader.send({ type: 'group.end' });
    await leader.next('join.requested');
    await leader.next('join.requested');
    await leader.next('group.ended');
    for (const { joiner } of asks) {
      expect(await joiner.next('error')).toEqual({
        type: 'error',
        code: 'GROUP_ENDED',
        message: 'Group has ended',
      });
    }
    expect(store.size).toBe(0);
    expect(scheduler.pending).toBe(0);
    // The joiner is free again.
    asks[0]!.joiner.send({ type: 'group.create', metadata: {} });
    expect((await asks[0]!.joiner.next('group.created')).groupId).not.toBe(created.groupId);
  });

  it('tells pending joiners GROUP_ENDED when the group leaves memory', async () => {
    const { server, store } = await start();
    const { leader, join } = await bGroup(server);
    const { joiner } = await ask(server, join.joinCode);
    await leader.close();
    expect(await joiner.next('error')).toEqual({
      type: 'error',
      code: 'GROUP_ENDED',
      message: 'Group has ended',
    });
    await waitUntil(() => store.size === 0);
  });
});

describe('settles exactly once (#10 R11)', () => {
  it('approve after the deadline fired finds nothing, and nobody is added', async () => {
    const { server, scheduler, store } = await start();
    const { leader, created, join } = await bGroup(server);
    const { joiner, pending } = await ask(server, join.joinCode);
    await leader.next('join.requested');
    scheduler.advance(TIMEOUT_MS);
    leader.send({ type: 'join.approve', requestId: pending.requestId });
    const replies = [await nextNonRefresh(leader), await nextNonRefresh(leader)];
    expect(replies.map((r) => (r.type === 'error' ? r.code : r.type)).sort()).toEqual([
      'JOIN_REQUEST_NOT_FOUND',
      'join.withdrawn',
    ]);
    expect(await joiner.next('error')).toMatchObject({ code: 'APPROVAL_TIMEOUT' });
    await joiner.expectNoMessage(30);
    expect((await store.get('app-a', created.groupId))?.participantIds).toHaveLength(1);
  });

  it('a timer after approve does nothing', async () => {
    const { server, scheduler } = await start();
    const { leader, join } = await bGroup(server);
    const { joiner, pending } = await ask(server, join.joinCode);
    await leader.next('join.requested');
    leader.send({ type: 'join.approve', requestId: pending.requestId });
    await leader.next('join.decided');
    await joiner.next('group.joined');
    scheduler.advance(TIMEOUT_MS);
    await joiner.expectNoMessage(30);
  });

  it('approve racing cancel and disconnect gives one outcome to each side', async () => {
    for (const race of ['cancel', 'disconnect'] as const) {
      const { server, store } = await start();
      const { leader, created, join } = await bGroup(server);
      const { joiner, pending } = await ask(server, join.joinCode);
      await leader.next('join.requested');
      if (race === 'cancel') joiner.send({ type: 'join.cancel' });
      else joiner.terminate();
      leader.send({ type: 'join.approve', requestId: pending.requestId });
      const first = await leader.next();
      if (first.type === 'join.decided') {
        // Approve won.
        expect(first.outcome).toBe('admitted');
        if (race === 'cancel') {
          expect(await joiner.next('group.joined')).toBeDefined();
          expect(await joiner.next('error')).toMatchObject({ code: 'JOIN_REQUEST_NOT_FOUND' });
        }
      } else {
        // Cancel or disconnect won: withdrawn, then the approve finds nothing.
        expect(first).toMatchObject({ type: 'join.withdrawn' });
        expect(await leader.next('error')).toMatchObject({ code: 'JOIN_REQUEST_NOT_FOUND' });
        if (race === 'cancel') expect((await joiner.next()).type).toBe('join.cancelled');
      }
      await leader.expectNoMessage(30);
      if (race === 'disconnect') {
        await waitUntil(
          async () => (await store.get('app-a', created.groupId))?.participantIds.length === 1,
        );
      }
      await ts?.close();
      ts = undefined;
    }
  });
});
