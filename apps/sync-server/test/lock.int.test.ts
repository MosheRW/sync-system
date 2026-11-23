import { randomBytes } from 'node:crypto';
import type { JoinMethod } from '@mosherw/sync-system-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import { JOIN_ATTEMPTS_PER_CONNECTION_PER_MINUTE } from '../src/limits/constants.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

const ALL: JoinMethod[] = ['A', 'B', 'C', 'D'];
const LOCKED = { type: 'error', code: 'GROUP_LOCKED', message: 'Group is locked' };

async function start() {
  const scheduler = new ManualScheduler();
  const store = new InMemoryGroupStore();
  ts = await startTestServer({
    scheduler,
    store,
    apps: [{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ALL }],
  });
  return { scheduler, store, ts };
}

async function leaderOf(server: TestServer, joinMethods: JoinMethod[]) {
  const leader = await server.connectReady();
  leader.send({ type: 'group.create', metadata: {}, joinMethods });
  return { leader, created: await leader.next('group.created') };
}

async function lock(leader: TestClient, locked = true) {
  leader.send({ type: locked ? 'group.lock' : 'group.unlock', reqId: 'l' });
  return leader.next();
}

async function ticketOf(leader: TestClient): Promise<string> {
  leader.send({ type: 'qr.issue' });
  return (await leader.next('qr.ticket')).ticket;
}

async function attempt(server: TestServer, frame: Record<string, unknown>) {
  const client = await server.connectReady();
  client.send(frame);
  return { client, reply: await client.next() };
}

describe('lock group (#13 AC29, D14, RC3)', () => {
  it('replies lock.changed, tells members once per change, and is idempotent', async () => {
    const { store } = await start();
    const group = await createGroupWithMembers(ts!, 1);
    expect(await lock(group.leader)).toEqual({
      type: 'lock.changed',
      reqId: 'l',
      groupId: group.groupId,
      locked: true,
    });
    expect(await group.members[0]!.next('lock.changed')).toEqual({
      type: 'lock.changed',
      groupId: group.groupId,
      locked: true,
    });
    expect(await lock(group.leader)).toMatchObject({ locked: true });
    await group.members[0]!.expectNoMessage(30);
    expect((await store.get('app-a', group.groupId))?.locked).toBe(true);
    expect(await lock(group.leader, false)).toMatchObject({ locked: false });
    expect(await group.members[0]!.next('lock.changed')).toMatchObject({ locked: false });
  });

  it('refuses every method with the same bytes and no details', async () => {
    await start();
    const a = await leaderOf(ts!, ['A', 'D']);
    const b = await leaderOf(ts!, ['B']);
    const c = await leaderOf(ts!, ['C']);
    const ticket = await ticketOf(a.leader);
    for (const { leader } of [a, b, c]) await lock(leader);
    const replies = [
      (
        await attempt(ts!, {
          type: 'group.joinByCode',
          joinCode: a.created.codes.groupCode,
          doorCode: a.created.codes.doorCode,
        })
      ).reply,
      (await attempt(ts!, { type: 'group.joinByCode', joinCode: b.created.codes.groupCode })).reply,
      (await attempt(ts!, { type: 'group.joinByCode', joinCode: c.created.codes.alphaCode })).reply,
      (await attempt(ts!, { type: 'group.joinByQr', ticket })).reply,
    ];
    for (const reply of replies) expect(reply).toEqual(LOCKED);
  });

  it('charges the join budget first and never counts a door failure while locked', async () => {
    await start();
    const { leader, created } = await leaderOf(ts!, ['A']);
    await lock(leader);
    const client = await ts!.connectReady();
    for (let i = 0; i < JOIN_ATTEMPTS_PER_CONNECTION_PER_MINUTE; i++) {
      client.send({
        type: 'group.joinByCode',
        joinCode: created.codes.groupCode,
        doorCode: '000000',
      });
      expect(await client.next()).toEqual(LOCKED);
    }
    client.send({
      type: 'group.joinByCode',
      joinCode: created.codes.groupCode,
      doorCode: '000000',
    });
    expect(await client.next('error')).toMatchObject({ code: 'RATE_LIMITED' });
    // Ten wrong door codes were never compared: no rotation, no pause.
    await leader.expectNoMessage(30);
  });

  it('answers QR_INVALID or QR_EXPIRED for a bad ticket on a locked group', async () => {
    const { scheduler } = await start();
    const { leader } = await leaderOf(ts!, ['D']);
    const ticket = await ticketOf(leader);
    leader.send({ type: 'codes.rotate' });
    await leader.next('codes.updated');
    const fresh = await ticketOf(leader);
    await lock(leader);
    expect((await attempt(ts!, { type: 'group.joinByQr', ticket })).reply).toMatchObject({
      code: 'QR_INVALID',
    });
    scheduler.advance(301_000);
    expect((await attempt(ts!, { type: 'group.joinByQr', ticket: fresh })).reply).toMatchObject({
      code: 'QR_EXPIRED',
    });
  });

  it('keeps a pending request; approve is refused while locked and works after unlock (Q4.2)', async () => {
    await start();
    const { leader, created } = await leaderOf(ts!, ['B']);
    const { client: joiner } = await attempt(ts!, {
      type: 'group.joinByCode',
      joinCode: created.codes.groupCode,
    });
    const requested = await leader.next('join.requested');
    await lock(leader);
    leader.send({ type: 'join.approve', requestId: requested.requestId });
    expect(await leader.next('error')).toEqual(LOCKED);
    await lock(leader, false);
    leader.send({ type: 'join.approve', requestId: requested.requestId });
    expect(await leader.next('join.decided')).toMatchObject({ outcome: 'admitted' });
    expect(await joiner.next('group.joined')).toMatchObject({ locked: false });
  });

  it('lets members back in by token while locked, and tells them it is locked', async () => {
    await start();
    const group = await createGroupWithMembers(ts!, 1);
    await lock(group.leader);
    await group.members[0]!.next('lock.changed');
    await group.members[0]!.close();
    const { reply } = await resumeWith(ts!, group.memberTokens[0]);
    expect(reply).toMatchObject({ type: 'group.joined', locked: true });
  });

  it('refuses a member with NOT_LEADER and spends nothing', async () => {
    await start();
    const group = await createGroupWithMembers(ts!, 1);
    group.members[0]!.send({ type: 'group.lock' });
    expect(await group.members[0]!.next('error')).toMatchObject({
      code: 'NOT_LEADER',
      message: 'Only the leader can lock the group',
    });
    expect(await lock(group.leader)).toMatchObject({ type: 'lock.changed' });
  });

  it('restores the lock after a restart and still admits parked members (Q4.3)', async () => {
    const tokenSecrets = { current: randomBytes(32), source: 'env' as const };
    ts = await startTestServer({ tokenSecrets });
    const group = await createGroupWithMembers(ts, 1);
    await ts.close();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ tokenSecrets, store });
    const { client: parked } = await resumeWith(ts, group.memberTokens[0]);
    const { reply } = await resumeWith(ts, group.leaderToken, {
      metadata: {},
      locked: true,
      joinCodes: group.codes.blob,
    });
    expect(reply).toMatchObject({ type: 'group.resumed', state: { locked: true } });
    expect(await parked.next('group.joined')).toMatchObject({ locked: true });
    const late = await ts.connectReady();
    late.send({ type: 'group.joinByCode', ...group.join });
    expect(await late.next()).toEqual(LOCKED);
  });
});
