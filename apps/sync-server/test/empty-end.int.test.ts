import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenSecretsInput } from '../src/config/token-secret.js';
import type { GroupRecord } from '../src/groups/group-store.js';
import { InMemoryGroupStore } from '../src/groups/in-memory-group-store.js';
import {
  MAX_CLOCK_SKEW_MS,
  RECREATIONS_PER_CONNECTION_PER_MINUTE,
} from '../src/limits/constants.js';
import { TokenKeyring } from '../src/tokens/token-keys.js';
import { TokenService } from '../src/tokens/token-service.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { GRACE_MS, expireHold, isHeld } from './helpers/lifecycle.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';
import { claimsOf } from './helpers/tokens.js';
import { sleep, waitUntil } from './helpers/wait.js';
import { testSecrets } from './helpers/token-secrets.js';

const MINUTE = 60_000;
/** Default inactivity limit (20 min) plus the default max refresh interval (300 s). */
const WINDOW = 20 * MINUTE + 300_000;

let ts: TestServer | undefined;

afterEach(async () => {
  await ts?.close();
  ts = undefined;
});

function secrets(): TokenSecretsInput {
  return { current: randomBytes(32), source: 'env' };
}

async function check(client: TestClient, tokens: unknown[]) {
  client.send({ type: 'tokens.check', tokens });
  const reply = await client.next('tokens.result');
  return reply.results.map((result) => result.status);
}

function emptyEnds(server: TestServer) {
  return server.logs.records().filter((r) => r.event === 'group_ended' && r.endReason === 'empty');
}

describe('a group that empties ends (#13 D15, RC17)', () => {
  it('ends when the solo leader disconnects: logged only, timers gone, codes freed', async () => {
    const scheduler = new ManualScheduler();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ scheduler, store });
    const group = await createGroupWithMembers(ts, 0);
    await group.leader.close();
    await expireHold(scheduler, store, group.groupId);
    expect(emptyEnds(ts)).toHaveLength(1);
    expect(ts.logs.events()).not.toContain('group_dropped');
    expect(scheduler.pending).toBe(0);
    const late = await ts.connectReady();
    late.send({ type: 'group.joinByCode', ...group.join });
    expect(await late.next('error')).toMatchObject({ code: 'CODE_NOT_FOUND' });
  });

  it('ends when the leader is offline and the last member disconnects', async () => {
    const store = new InMemoryGroupStore();
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ store, scheduler });
    const group = await createGroupWithMembers(ts, 1);
    await group.leader.close();
    await group.members[0]!.next('leader.offline');
    await group.members[0]!.close();
    await expireHold(scheduler, store, group.groupId);
    expect(emptyEnds(ts)).toHaveLength(1);
  });

  it('ends when the leader is offline and the last member leaves, with no frame', async () => {
    const store = new InMemoryGroupStore();
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ store, scheduler });
    const group = await createGroupWithMembers(ts, 1);
    await group.leader.close();
    const member = group.members[0]!;
    await member.next('leader.offline');
    member.send({ type: 'group.leave', reqId: 'l' });
    expect(await member.next()).toEqual({ type: 'group.left', reqId: 'l', groupId: group.groupId });
    await expireHold(scheduler, store, group.groupId);
    // The leaver got its reply only; nobody is told about an empty end.
    await member.expectNoMessage(50);
    expect(emptyEnds(ts)).toHaveLength(1);
  });

  it('answers a pending joiner of an emptied group with GROUP_ENDED', async () => {
    const store = new InMemoryGroupStore();
    const scheduler = new ManualScheduler();
    ts = await startTestServer({
      store,
      scheduler,
      apps: [{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ['B'] }],
    });
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {}, joinMethods: ['B'] });
    const created = await leader.next('group.created');
    const joiner = await ts.connectReady();
    joiner.send({ type: 'group.joinByCode', joinCode: created.codes.groupCode });
    await joiner.next('join.pending');
    await leader.close();
    await expireHold(scheduler, store, created.groupId);
    expect(await joiner.next('error')).toMatchObject({ code: 'GROUP_ENDED' });
    expect(store.size).toBe(0);
  });

  it('no token of the group recreates it in this process; tokens.check says ended', async () => {
    const scheduler = new ManualScheduler();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ scheduler, store });
    const group = await createGroupWithMembers(ts, 1);
    const poller = await ts.connectReady();
    expect(await check(poller, [group.leaderToken, group.memberTokens[0]])).toEqual([
      'live',
      'live',
    ]);
    await group.members[0]!.close();
    await group.leader.close();
    await expireHold(scheduler, store, group.groupId);
    scheduler.advance(MINUTE);
    for (const token of [group.leaderToken, group.memberTokens[0]]) {
      const { reply } = await resumeWith(ts, token, { metadata: {} });
      expect(reply).toMatchObject({ code: 'GROUP_ENDED' });
    }
    expect(store.size).toBe(0);
    // Polled across the end: live, then ended, never recoverable (6.6.3 row 12).
    for (let i = 0; i < 5; i++) {
      expect(await check(poller, [group.leaderToken, group.memberTokens[0]])).toEqual([
        'ended',
        'ended',
      ]);
      scheduler.advance(6_000);
    }
  });

  it('keeps refusing with the entry evicted: the iat fence (6.9 layer 2)', async () => {
    const scheduler = new ManualScheduler();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ scheduler, store, endedGroupsCap: 1 });
    const first = await createGroupWithMembers(ts, 1);
    await first.members[0]!.close();
    await first.leader.close();
    await expireHold(scheduler, store, first.groupId);
    // A second end evicts the first group's entry.
    const second = await createGroupWithMembers(ts, 0);
    second.leader.send({ type: 'group.end' });
    await second.leader.next('group.ended');
    for (const token of [first.leaderToken, first.memberTokens[0]]) {
      expect((await resumeWith(ts, token, { metadata: {} })).reply).toMatchObject({
        code: 'GROUP_ENDED',
      });
    }
    const poller = await ts.connectReady();
    expect(await check(poller, [first.leaderToken, first.memberTokens[0]])).toEqual([
      'ended',
      'ended',
    ]);
    expect(store.size).toBe(0);
  });

  it('floors iat at the process start, so a clock stepped back keeps the fence (RC18)', async () => {
    const scheduler = new ManualScheduler();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ scheduler, store, endedGroupsCap: 1 });
    const startedAt = scheduler.now();
    // The clock steps back 10 s (inside the skew) after the start.
    scheduler.time = startedAt - 10_000;
    const group = await createGroupWithMembers(ts, 0);
    expect(claimsOf(group.leaderToken).iat).toBe(Math.floor(startedAt / 1000));
    await group.leader.close();
    await expireHold(scheduler, store, group.groupId);
    const other = await createGroupWithMembers(ts, 0);
    other.leader.send({ type: 'group.end' });
    await other.leader.next('group.ended');
    expect((await resumeWith(ts, group.leaderToken, { metadata: {} })).reply).toMatchObject({
      code: 'GROUP_ENDED',
    });
    expect(store.size).toBe(0);
  });

  it('a pre-restart member token still parks after a restart (#5 AC25 stays)', async () => {
    const tokenSecrets = secrets();
    ts = await startTestServer({ tokenSecrets });
    const group = await createGroupWithMembers(ts, 1);
    await ts.close();
    ts = await startTestServer({ tokenSecrets });
    const { reply } = await resumeWith(ts, group.memberTokens[0]);
    expect(reply).toEqual({ type: 'group.waiting', groupId: group.groupId });
  });
});

describe('groups recreated after a restart, then emptied (#13 6.9 layer 1)', () => {
  async function recreatedThenEmptied() {
    const tokenSecrets = secrets();
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ tokenSecrets, scheduler });
    const group = await createGroupWithMembers(ts, 0);
    await ts.close();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ tokenSecrets, scheduler, store });
    const startedAt = scheduler.now();
    const { client, reply } = await resumeWith(ts, group.leaderToken, { metadata: {} });
    expect(reply).toMatchObject({ type: 'group.resumed', recreated: true });
    if (reply.type !== 'group.resumed') throw new Error('expected group.resumed');
    await client.close();
    await expireHold(scheduler, store, group.groupId);
    return { group, scheduler, store, startedAt, inProcessToken: reply.token };
  }

  it('refuses the pre-restart token by the guarded entry, then as expired, never recoverable', async () => {
    const { group, scheduler, store, startedAt, inProcessToken } = await recreatedThenEmptied();
    const poller = await ts!.connectReady();
    expect(await check(poller, [group.leaderToken, inProcessToken])).toEqual(['ended', 'ended']);
    // Past the guard: the pre-restart leader token is lat-expired anyway.
    scheduler.advanceTo(startedAt + WINDOW + MAX_CLOCK_SKEW_MS);
    const later = await ts!.connectReady();
    const statuses = await check(later, [group.leaderToken, inProcessToken]);
    expect(statuses[0]).toMatch(/^(ended|expired)$/);
    expect(statuses[1]).toBe('ended');
    expect((await resumeWith(ts!, group.leaderToken, { metadata: {} })).reply).toMatchObject({
      type: 'error',
    });
    expect(store.size).toBe(0);
  });

  it('sets recoveredAt above a recreating term that ran ahead of the clock (RC18)', async () => {
    const tokenSecrets = secrets();
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ tokenSecrets, scheduler });
    const group = await createGroupWithMembers(ts, 0);
    await ts.close();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({ tokenSecrets, scheduler, store });
    const claims = claimsOf(group.leaderToken);
    // A pre-restart token (iat before this process) whose term is 5 ms ahead.
    const issuer = new TokenService(new TokenKeyring(testSecrets(tokenSecrets)));
    const ahead = issuer.issue({
      namespace: 'app-a',
      groupId: claims.gid,
      participantId: claims.pid,
      role: 'leader',
      groupCreatedAt: claims.gct,
      lastActivityAt: claims.lat,
      term: scheduler.now() + 5,
      now: claims.iat * 1000,
    });
    const { reply } = await resumeWith(ts, ahead, { metadata: {} });
    expect(reply).toMatchObject({ type: 'group.resumed', recreated: true });
    const record = (await store.get('app-a', group.groupId)) as GroupRecord;
    expect(record.term).toBe(scheduler.now() + 5);
    expect(record.recoveredAt).toBe(scheduler.now() + 6);
  });
});

describe('recreation budget per connection (#13 RC20, M5)', () => {
  it('limits recreating resumes on one connection; other resumes are not charged', async () => {
    const tokenSecrets = secrets();
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ tokenSecrets, scheduler });
    const groups = [];
    for (let i = 0; i <= RECREATIONS_PER_CONNECTION_PER_MINUTE; i++) {
      groups.push(await createGroupWithMembers(ts, 0));
    }
    await ts.close();
    ts = await startTestServer({ tokenSecrets, scheduler });
    const client = await ts.connectReady();
    for (const group of groups.slice(0, RECREATIONS_PER_CONNECTION_PER_MINUTE)) {
      client.send({ type: 'group.resume', token: group.leaderToken, metadata: {} });
      expect(await client.next('group.resumed')).toMatchObject({ recreated: true });
      client.send({ type: 'group.end' });
      await client.next('group.ended');
    }
    const last = groups[RECREATIONS_PER_CONNECTION_PER_MINUTE]!;
    client.send({ type: 'group.resume', token: last.leaderToken, metadata: {} });
    expect(await client.next('error')).toMatchObject({
      code: 'RATE_LIMITED',
      message: 'Too many group recoveries',
    });
    // Another connection has its own budget.
    const other = await ts.connectReady();
    other.send({ type: 'group.resume', token: last.leaderToken, metadata: {} });
    expect(await other.next('group.resumed')).toMatchObject({ recreated: true });
  });
});

/** A store whose next `get` waits until released, to hold the group lock. */
class GatedStore extends InMemoryGroupStore {
  private gate: Promise<void> | undefined;
  hit = false;

  holdNextGet(): () => void {
    let release: () => void = () => undefined;
    this.gate = new Promise((resolve) => {
      release = resolve;
    });
    return release;
  }

  override async get(namespace: string, id: string): Promise<GroupRecord | undefined> {
    const gate = this.gate;
    if (gate !== undefined) {
      this.gate = undefined;
      this.hit = true;
      await gate;
    }
    return super.get(namespace, id);
  }
}

describe('a late close of an old socket (#13 RC19, L12)', () => {
  it('does not end or pause a group whose leader already resumed on a new socket', async () => {
    const store = new GatedStore();
    ts = await startTestServer({ store, scheduler: new ManualScheduler() });
    const group = await createGroupWithMembers(ts, 0);
    const fresh = await ts.connectReady();
    const release = store.holdNextGet();
    fresh.send({ type: 'group.resume', token: group.leaderToken });
    // The resume holds the group lock, waiting in the store.
    await waitUntil(() => store.hit);
    // The old socket closes; its disconnect unregisters, then waits for the lock.
    group.leader.terminate();
    await sleep(50);
    release();
    expect(await fresh.next('group.resumed')).toMatchObject({ recreated: false });
    await sleep(50);
    const record = await store.get('app-a', group.groupId);
    expect(record?.leaderOnline).toBe(true);
    expect(emptyEnds(ts)).toHaveLength(0);
    fresh.send({ type: 'position.update', position: 1 });
    expect(await fresh.next('position.ack')).toEqual({ type: 'position.ack' });
  });
});

describe('the empty-group hold (#13 Gate 2 Q-G, RC21)', () => {
  async function held(handoff: 'auto' | 'frozen' = 'auto', joinMethods = ['A', 'B', 'C', 'D']) {
    const scheduler = new ManualScheduler();
    const store = new InMemoryGroupStore();
    ts = await startTestServer({
      scheduler,
      store,
      apps: [{ namespace: 'app-a', apiKey: KEY_A, defaultHandoff: handoff, joinMethods }],
    });
    return { scheduler, store };
  }

  it('refuses every new admission while held with the locked-group answer (RC21 a)', async () => {
    const { store } = await held();
    const leader = await ts!.connectReady();
    leader.send({ type: 'group.create', metadata: {}, joinMethods: ['A', 'D'] });
    const created = await leader.next('group.created');
    leader.send({ type: 'qr.issue' });
    const { ticket } = await leader.next('qr.ticket');
    const b = await ts!.connectReady();
    b.send({ type: 'group.create', metadata: {}, joinMethods: ['B'] });
    const bCreated = await b.next('group.created');
    const asking = await ts!.connectReady();
    asking.send({ type: 'group.joinByCode', joinCode: bCreated.codes.groupCode });
    await asking.next('join.pending');
    await leader.close();
    await b.close();
    await waitUntil(
      async () => (await isHeld(store, created.groupId)) && (await isHeld(store, bCreated.groupId)),
    );
    const locked = { type: 'error', code: 'GROUP_LOCKED', message: 'Group is locked' };
    const byCode = await ts!.connectReady();
    byCode.send({
      type: 'group.joinByCode',
      joinCode: created.codes.groupCode,
      doorCode: created.codes.doorCode,
    });
    expect(await byCode.next()).toEqual(locked);
    const byQr = await ts!.connectReady();
    byQr.send({ type: 'group.joinByQr', ticket });
    expect(await byQr.next()).toEqual(locked);
    const byB = await ts!.connectReady();
    byB.send({ type: 'group.joinByCode', joinCode: bCreated.codes.groupCode });
    expect(await byB.next()).toEqual(locked);
    expect((await store.get('app-a', created.groupId))?.participantIds).toHaveLength(1);
  });

  it('a leader back inside the hold keeps the lead with no role change', async () => {
    const { scheduler, store } = await held();
    const group = await createGroupWithMembers(ts!, 1);
    await group.members[0]!.close();
    await group.leader.close();
    await waitUntil(() => isHeld(store, group.groupId));
    scheduler.advance(GRACE_MS - 1);
    const { reply } = await resumeWith(ts!, group.leaderToken);
    expect(reply).toMatchObject({ type: 'group.resumed', recreated: false });
    scheduler.advance(10 * 60_000);
    expect(await store.get('app-a', group.groupId)).toMatchObject({
      leaderId: group.leaderId,
      pause: undefined,
      leaderOnline: true,
    });
  });

  it('a member back inside the hold takes over at the original deadline, not later', async () => {
    const { scheduler, store } = await held();
    const group = await createGroupWithMembers(ts!, 1);
    await group.leader.close();
    await group.members[0]!.next('leader.offline');
    const deadline = (await store.get('app-a', group.groupId))?.pause?.graceEndsAt;
    await group.members[0]!.close();
    await waitUntil(() => isHeld(store, group.groupId));
    scheduler.advance(10_000);
    const { client } = await resumeWith(ts!, group.memberTokens[0]);
    expect((await store.get('app-a', group.groupId))?.pause?.graceEndsAt).toBe(deadline);
    scheduler.advanceTo(deadline! - 1);
    await client.expectNoMessage(30);
    scheduler.advanceTo(deadline!);
    expect(await client.next('leader.granted')).toMatchObject({ reason: 'handoff_disconnect' });
  });

  it('a frozen-mode empty group ends at the hold deadline, not the frozen bound', async () => {
    const { scheduler, store } = await held('frozen');
    const group = await createGroupWithMembers(ts!, 0);
    await group.leader.close();
    await waitUntil(() => isHeld(store, group.groupId));
    expect((await store.get('app-a', group.groupId))?.pause).toEqual({
      cause: 'offline',
      holdEndsAt: scheduler.now() + GRACE_MS,
    });
    scheduler.advance(GRACE_MS - 1);
    expect(store.size).toBe(1);
    scheduler.advance(1);
    await waitUntil(() => store.size === 0);
    expect(emptyEnds(ts!)).toHaveLength(1);
  });

  it('never extends the hold: a member back and gone again ends it at the first deadline', async () => {
    const { scheduler, store } = await held('frozen');
    const group = await createGroupWithMembers(ts!, 1);
    await group.leader.close();
    await group.members[0]!.close();
    await waitUntil(() => isHeld(store, group.groupId));
    scheduler.advance(GRACE_MS - 5_000);
    const { client } = await resumeWith(ts!, group.memberTokens[0]);
    scheduler.advance(10_000);
    // Someone was connected at the deadline: frozen mode keeps waiting.
    expect(store.size).toBe(1);
    await client.close();
    // The hold already ran out, so the group ends at once.
    await waitUntil(() => store.size === 0);
  });
});
