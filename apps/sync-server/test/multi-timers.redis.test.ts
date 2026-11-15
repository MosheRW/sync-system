import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { type TestCluster, startCluster } from './helpers/cluster.js';
import { type TestGroup, codesOf } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { describeRedis, inspector } from './helpers/redis.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, type TestAppInput, type TestServer } from './helpers/test-server.js';
import { sleep, waitUntil } from './helpers/wait.js';

const MINUTE = 60_000;
/** Default inactivity limit 20 min and countdown 60 s: the prompt is due after 19 min. */
const PROMPT_AFTER = 19 * MINUTE;
const COUNTDOWN = 60_000;
/** Past the default disconnect grace (30 s). */
const GRACE = 31_000;
/**
 * After an outcome, long enough for every instance's safety poll
 * (TIMER_POLL_MS, 1 s) to run: a second firing would show by then.
 */
const SETTLE_MS = 1_500;

/**
 * AC19 with three instances (#35 architecture 12.17): each timer kind fires
 * once, counted by its outcome and by the `timer_claimed` debug log (the
 * test hook) summed over the instances. `maxSession` is covered in
 * multi-cluster, `approvalDue` here and in multi-approvals.
 */
describeRedis('every timer kind fires once with three instances (#35 AC19)', () => {
  vi.setConfig({ testTimeout: 30_000 });
  let inspect: Awaited<ReturnType<typeof inspector>>;
  let cluster: TestCluster | undefined;
  let scheduler: ManualScheduler;

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

  /** Three instances on one manual clock, each knowing the others are live. */
  async function threeInstances(apps?: TestAppInput[]): Promise<TestServer[]> {
    scheduler = new ManualScheduler();
    cluster = await startCluster({ size: 3, scheduler, ...(apps === undefined ? {} : { apps }) });
    await cluster.converged();
    return cluster.nodes.map((node) => node.ts);
  }

  /** Claims of `kind` over every instance. */
  function claims(kind: string): number {
    return cluster!.nodes
      .map(
        (node) =>
          node.ts.logs.records().filter((r) => r.event === 'timer_claimed' && r.kind === kind)
            .length,
      )
      .reduce((sum, n) => sum + n, 0);
  }

  function count(client: TestClient, type: string): number {
    return client.received.filter((f) => f.type === type).length;
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

  it('keep-alive prompt, keep-alive deadline and grace each fire once', async () => {
    const [a, b, c] = await threeInstances();
    const group = await groupAcross(a!, [b!, c!]);
    const [first, second] = group.members as [TestClient, TestClient];

    // keepAlivePrompt: one prompt to the leader.
    scheduler.advance(PROMPT_AFTER);
    await waitUntil(() => count(group.leader, 'keepalive.prompt') === 1, 5_000);
    await sleep(SETTLE_MS);
    expect(count(group.leader, 'keepalive.prompt')).toBe(1);
    expect(claims('keepAlivePrompt')).toBe(1);

    // keepAliveDeadline: no answer, so the group pauses once (inactive).
    scheduler.advance(COUNTDOWN);
    await waitUntil(() => group.members.every((m) => count(m, 'leader.offline') === 1), 5_000);
    await sleep(SETTLE_MS);
    for (const member of group.members) {
      expect(count(member, 'leader.offline')).toBe(1);
      expect(member.received.find((f) => f.type === 'leader.offline')).toMatchObject({
        cause: 'inactive',
      });
    }
    expect(claims('keepAliveDeadline')).toBe(1);

    // grace: one handoff, to the first member; the other is told once.
    scheduler.advance(GRACE);
    await waitUntil(() => count(first, 'leader.granted') === 1, 5_000);
    await waitUntil(() => count(second, 'leader.changed') === 1, 5_000);
    await sleep(SETTLE_MS);
    expect(first.received.find((f) => f.type === 'leader.granted')).toMatchObject({
      reason: 'handoff_inactivity',
    });
    expect(count(first, 'leader.granted')).toBe(1);
    expect(count(second, 'leader.granted')).toBe(0);
    expect(count(second, 'leader.changed')).toBe(1);
    expect(count(group.leader, 'leader.lost')).toBe(1);
    expect(claims('grace')).toBe(1);
  });

  it('the frozen bound ends the group once', async () => {
    const [a, b, c] = await threeInstances([
      { namespace: 'app-a', apiKey: KEY_A, defaultHandoff: 'frozen' },
    ]);
    const group = await groupAcross(a!, [b!, c!]);
    group.leader.terminate();
    await waitUntil(() => group.members.every((m) => count(m, 'leader.offline') === 1), 5_000);
    // Inactivity limit (20 min) plus the max refresh interval (300 s), and more.
    scheduler.advance(20 * MINUTE + 300_000 + MINUTE);
    await waitUntil(() => group.members.every((m) => count(m, 'group.ended') === 1), 5_000);
    await sleep(SETTLE_MS);
    for (const member of group.members) expect(count(member, 'group.ended')).toBe(1);
    expect(claims('frozenEnd')).toBe(1);
    expect(await inspect.keys(`${cluster!.prefix}:v1:g`)).toEqual([]);
  });

  it('the end of a door-code pause fires once', async () => {
    const nodes = await threeInstances([
      { namespace: 'app-a', apiKey: KEY_A, joinMethods: ['A', 'C'], maxGroupSize: 100 },
    ]);
    const leader = await nodes[0]!.connectReady();
    leader.send({ type: 'group.create', metadata: {}, joinMethods: ['A', 'C'] });
    const created = await leader.next('group.created');
    const groupCode = created.codes.groupCode!;
    let door = created.codes.doorCode!;
    // Three rotations of 5 wrong door codes, spread over the three instances.
    let attempt = 0;
    for (let rotation = 0; rotation < 3; rotation++) {
      const wrong = ['000000', '000001', '000002'].find((x) => x !== groupCode && x !== door)!;
      for (let i = 0; i < 5; i++) {
        const guesser = await nodes[attempt++ % 3]!.connectReady();
        guesser.send({ type: 'group.joinByCode', joinCode: groupCode, doorCode: wrong });
        expect(await guesser.next('error')).toMatchObject({ code: 'DOOR_CODE_WRONG' });
        guesser.terminate();
      }
      door = (await leader.next('codes.updated')).codes.doorCode!;
      if (rotation < 2) scheduler.advance(5 * MINUTE);
    }
    expect(await leader.next('join.paused')).toMatchObject({ retryAfterMs: 10 * MINUTE });
    scheduler.advance(10 * MINUTE);
    await waitUntil(() => count(leader, 'join.resumed') === 1, 5_000);
    await sleep(SETTLE_MS);
    expect(count(leader, 'join.resumed')).toBe(1);
    expect(claims('doorPauseEnd')).toBe(1);
    // Door-code joining works again, on any instance.
    const joiner = await nodes[2]!.connectReady();
    joiner.send({ type: 'group.joinByCode', joinCode: groupCode, doorCode: door });
    expect(await joiner.next('group.joined')).toMatchObject({ groupId: created.groupId });
  });

  it('a method B request deadline fires once', async () => {
    const [a, , c] = await threeInstances([
      { namespace: 'app-a', apiKey: KEY_A, joinMethods: ['B', 'D'], approvalTimeoutSeconds: 15 },
    ]);
    const leader = await a!.connectReady();
    leader.send({ type: 'group.create', metadata: {}, joinMethods: ['B'] });
    const created = await leader.next('group.created');
    const joiner = await c!.connectReady();
    joiner.send({ type: 'group.joinByCode', joinCode: created.codes.groupCode });
    const { requestId } = await joiner.next('join.pending');
    await leader.next('join.requested');
    scheduler.advance(15_000 + 1);
    expect(await joiner.next('error', 5_000)).toMatchObject({ code: 'APPROVAL_TIMEOUT' });
    expect(await leader.next('join.withdrawn', 5_000)).toMatchObject({
      requestId,
      reason: 'timeout',
    });
    await sleep(SETTLE_MS);
    expect(count(joiner, 'error')).toBe(1);
    expect(count(leader, 'join.withdrawn')).toBe(1);
    expect(claims('approvalDue')).toBe(1);
  });
});
