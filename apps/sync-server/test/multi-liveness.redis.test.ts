import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { type TestCluster, FAST_TIMINGS, startCluster } from './helpers/cluster.js';
import { type TestGroup, codesOf } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { describeRedis, inspector } from './helpers/redis.js';
import type { TestClient } from './helpers/test-client.js';
import type { TestServer } from './helpers/test-server.js';
import { claimsOf } from './helpers/tokens.js';
import { sleep, waitUntil } from './helpers/wait.js';

/** Past the default disconnect grace (30 s). */
const GRACE = 31_000;

/**
 * Instance A's timings: no renewal, sweep or fence during a test, so A's
 * live-instance cache never lists a peer started after A (the start-up
 * window of #42, held open). The peers keep the fast test timings.
 */
const SLOW = {
  ...FAST_TIMINGS,
  heartbeatMs: 20_000,
  selfFenceMs: 40_000,
  livenessMs: 60_000,
  sweepMs: 60_000,
};

interface Registry {
  a: Record<string, { i: string; t: string }>;
}

interface StoredRecord {
  leaderId: string;
  leaderOnline: boolean;
  participantIds: string[];
  pause?: unknown;
}

/**
 * A peer that started after this instance's last heartbeat is live in Redis
 * but missing from this instance's live cache; a grace end or a take-back
 * here confirms it in Redis instead of skipping it (#42, security C12, S4).
 */
describeRedis('a just-started instance is live for the successor pick and handoff (#42)', () => {
  vi.setConfig({ testTimeout: 20_000 });
  let inspect: Awaited<ReturnType<typeof inspector>>;
  let cluster: TestCluster | undefined;
  /** Instance A's clock; the peers' clocks never move, so only A claims the grace. */
  let clockA: ManualScheduler;

  beforeAll(async () => {
    inspect = await inspector();
  });
  afterAll(() => {
    inspect.close();
  });
  afterEach(async () => {
    const prefix = cluster?.prefix;
    await cluster?.close();
    cluster = undefined;
    if (prefix !== undefined) await inspect.flush(prefix);
  });

  /** A (slow, started first) and one peer started after it. */
  async function twoInstances(): Promise<[TestServer, TestServer]> {
    clockA = new ManualScheduler();
    cluster = await startCluster({
      perNode: (index) =>
        index === 0
          ? { scheduler: clockA, redisTimings: SLOW }
          : { scheduler: new ManualScheduler() },
    });
    const [a, peer] = cluster.nodes;
    return [a!.ts, peer!.ts];
  }

  async function groupAcross(leaderOn: TestServer, membersOn: TestServer[]): Promise<TestGroup> {
    const leader = await leaderOn.connectReady();
    leader.send({ type: 'group.create', metadata: { contentId: 'c' } });
    const created = await leader.next('group.created');
    const join = codesOf(created.codes);
    const members: TestClient[] = [];
    const memberTokens: string[] = [];
    const memberIds: string[] = [];
    for (const ts of membersOn) {
      const member = await ts.connectReady();
      member.send({ type: 'group.joinByCode', ...join });
      const joined = await member.next('group.joined');
      members.push(member);
      memberTokens.push(joined.token);
      memberIds.push(joined.participantId);
    }
    return {
      groupId: created.groupId,
      leader,
      members,
      leaderToken: created.token,
      leaderId: created.participantId,
      memberTokens,
      memberIds,
      codes: created.codes,
      join,
    };
  }

  async function storedRecord(groupId: string): Promise<StoredRecord> {
    const raw = await inspect.client.get(`${cluster!.prefix}:v1:g:app-a:${groupId}`);
    return (JSON.parse(raw!) as { record: StoredRecord }).record;
  }

  async function registry(groupId: string): Promise<Registry> {
    const raw = await inspect.client.get(`${cluster!.prefix}:v1:a:app-a:${groupId}`);
    return JSON.parse(raw!) as Registry;
  }

  function graceClaims(ts: TestServer): number {
    return ts.logs.records().filter((r) => r.event === 'timer_claimed' && r.kind === 'grace')
      .length;
  }

  /** The leader on A drops: its members are told and A's grace wake-up is set. */
  async function leaderDrops(group: TestGroup): Promise<void> {
    group.leader.terminate();
    for (const member of group.members) await member.next('leader.offline', 5_000);
    await waitUntil(
      () => clockA.nextAt !== undefined && clockA.nextAt <= clockA.now() + GRACE,
      5_000,
      'the grace wake-up on A',
    );
  }

  /** A's clock passes the grace end; A claims the grace timer. */
  async function graceEndsOnA(a: TestServer): Promise<void> {
    clockA.advance(GRACE);
    await waitUntil(() => graceClaims(a) === 1, 5_000, 'the grace claim on A');
  }

  async function leaderDropsAndGraceEndsOnA(a: TestServer, group: TestGroup): Promise<void> {
    await leaderDrops(group);
    await graceEndsOnA(a);
  }

  it('a grace ending on A hands the lead to the only member, on a peer A has not seen yet (AC1, AC2)', async () => {
    const [a, b] = await twoInstances();
    const group = await groupAcross(a, [b]);
    const [onB] = group.members as [TestClient];
    await leaderDropsAndGraceEndsOnA(a, group);
    const granted = await onB.next('leader.granted', 5_000);
    expect(granted).toMatchObject({ groupId: group.groupId, reason: 'handoff_disconnect' });
    expect(claimsOf(granted.token)).toMatchObject({ role: 'leader', pid: group.memberIds[0] });
    const record = await storedRecord(group.groupId);
    expect(record).toMatchObject({ leaderId: group.memberIds[0], leaderOnline: true });
    expect(record.pause).toBeUndefined();
    // A claimed and ran it; the peer never did (its clock did not move).
    expect(graceClaims(a)).toBe(1);
    expect(graceClaims(b)).toBe(0);
    expect(a.logs.find('grace_ended')).toBeUndefined();
  });

  it('a take-back on A tells the current leader on a peer A has not seen yet (AC3, S4)', async () => {
    const [a, b] = await twoInstances();
    const group = await groupAcross(a, [b]);
    const [onB] = group.members as [TestClient];
    const memberId = group.memberIds[0]!;
    await leaderDropsAndGraceEndsOnA(a, group);
    await onB.next('leader.granted', 5_000);
    // The displaced leader comes back on A and takes the lead back there.
    const back = await a.connectReady();
    back.send({ type: 'group.resume', token: group.leaderToken });
    expect(await back.next('group.joined', 5_000)).toMatchObject({ role: 'member' });
    expect(await back.next('takeback.offered', 5_000)).toBeDefined();
    back.send({ type: 'leader.takeBack', reqId: 't' });
    expect(await back.next('leader.granted', 5_000)).toMatchObject({
      reqId: 't',
      reason: 'take_back',
      groupId: group.groupId,
    });
    const lost = await onB.next('leader.lost', 5_000);
    expect(lost).toMatchObject({ reason: 'take_back', takeBackAvailable: false });
    expect(claimsOf(lost.token)).toMatchObject({ role: 'member', pid: memberId });
    const record = await storedRecord(group.groupId);
    expect(record.leaderId).toBe(group.leaderId);
    expect(record.participantIds).toContain(memberId);
    expect(Object.keys((await registry(group.groupId)).a)).toContain(memberId);
    // Still a member: it gets the new leader's moves.
    back.send({ type: 'position.update', position: { page: 4 } });
    expect(await onB.next('position.updated', 5_000)).toMatchObject({ position: { page: 4 } });
    expect(onB.isClosed).toBe(false);
  });

  it('a member on a stopped peer is still skipped: the group stays paused (AC4)', async () => {
    const [a, c] = await twoInstances();
    const group = await groupAcross(a, [c]);
    const memberId = group.memberIds[0]!;
    await leaderDrops(group);
    // C stops cleanly: its liveness key goes, its registry entry stays (A does not sweep).
    await cluster!.stop(cluster!.nodes[1]!);
    expect(Object.keys((await registry(group.groupId)).a)).toContain(memberId);
    await graceEndsOnA(a);
    await waitUntil(() => a.logs.find('grace_ended') !== undefined, 5_000, 'grace ended');
    await sleep(300);
    const record = await storedRecord(group.groupId);
    expect(record).toMatchObject({ leaderId: group.leaderId, leaderOnline: false });
    expect(record.pause).toBeDefined();
    expect(a.logs.find('leader_handoff')).toBeUndefined();
  });
});
