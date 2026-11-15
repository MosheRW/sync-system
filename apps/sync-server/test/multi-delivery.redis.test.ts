import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { type TestCluster, startCluster } from './helpers/cluster.js';
import { type TestGroup, codesOf } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { describeRedis, inspector } from './helpers/redis.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, type TestServer } from './helpers/test-server.js';
import { sleep, waitUntil } from './helpers/wait.js';

interface Registry {
  a: Record<string, { i: string; t: string }>;
}

/** Default inactivity limit 20 min and countdown 60 s: the prompt is due after 19 min. */
const PROMPT_AFTER = 19 * 60_000;
const COUNTDOWN = 60_000;
/** Past the default disconnect grace (30 s). */
const GRACE = 31_000;

/** Timers of `kind` this instance claimed (the `timer_claimed` debug log). */
function claims(ts: TestServer, kind: string): number {
  return ts.logs.records().filter((r) => r.event === 'timer_claimed' && r.kind === kind).length;
}

describeRedis('effects across instances over pub/sub (#35 AC17, architecture 12.7)', () => {
  let inspect: Awaited<ReturnType<typeof inspector>>;
  let cluster: TestCluster | undefined;

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

  /** A group led on `leaderOn` with one member joined on each of `membersOn`. */
  async function groupAcross(leaderOn: TestServer, membersOn: TestServer[]): Promise<TestGroup> {
    const leader = await leaderOn.connectReady();
    leader.send({ type: 'group.create', metadata: { contentId: 'c' }, position: { page: 1 } });
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

  async function registry(prefix: string, groupId: string): Promise<Registry> {
    return JSON.parse((await inspect.client.get(`${prefix}:v1:a:app-a:${groupId}`))!) as Registry;
  }

  it('a member on B gets the leader moves from A in order, each well under a second', async () => {
    cluster = await startCluster();
    const [a, b] = cluster.nodes;
    const group = await groupAcross(a!.ts, [b!.ts]);
    const member = group.members[0]!;
    // The leader on A sees the join on B through its roster.
    await waitUntil(() =>
      group.leader.rosterFrames.some(
        (f) => f.type === 'roster.updated' && f.participant.participantId === group.memberIds[0],
      ),
    );
    let worst = 0;
    for (let page = 2; page <= 21; page++) {
      const sent = Date.now();
      group.leader.send({ type: 'position.update', position: { page } });
      await group.leader.next('position.ack');
      expect(await member.next('position.updated')).toMatchObject({ position: { page } });
      worst = Math.max(worst, Date.now() - sent);
      // The leader's update rate is enforced on the leader's own instance.
      await sleep(210);
    }
    expect(worst).toBeLessThan(1_000);
  });

  it('a burst of updates arrives in order', async () => {
    cluster = await startCluster({
      env: {
        MAX_LEADER_UPDATE_RATE_CEILING: '60',
        MAX_INBOUND_MESSAGES_PER_SECOND: '100',
        MAX_INBOUND_BURST: '100',
      },
      apps: [{ namespace: 'app-a', apiKey: KEY_A, maxLeaderUpdatesPerSecond: 60 }],
    });
    const [a, b] = cluster.nodes;
    const group = await groupAcross(a!.ts, [b!.ts]);
    // Bursts of 10, under the per-connection queue cap.
    for (let burst = 0; burst < 5; burst++) {
      for (let page = 2 + burst * 10; page < 12 + burst * 10; page++) {
        group.leader.send({ type: 'position.update', position: { page } });
      }
      for (let i = 0; i < 10; i++) await group.leader.next('position.ack');
    }
    const seen: number[] = [];
    for (let i = 0; i < 50; i++) {
      const frame = await group.members[0]!.next('position.updated');
      seen.push((frame.position as { page: number }).page);
    }
    expect(seen).toEqual(Array.from({ length: 50 }, (_v, i) => i + 2));
  });

  it('lock, removal with 4004 and the end reach a member on another instance', async () => {
    cluster = await startCluster();
    const [a, b] = cluster.nodes;
    const group = await groupAcross(a!.ts, [b!.ts, b!.ts]);
    const [kept, removed] = group.members;
    group.leader.send({ type: 'group.lock' });
    await group.leader.next('lock.changed');
    expect(await kept!.next('lock.changed')).toMatchObject({ locked: true });
    expect(await removed!.next('lock.changed')).toMatchObject({ locked: true });
    group.leader.send({ type: 'member.remove', participantId: group.memberIds[1] });
    await group.leader.next('member.removed');
    expect(await removed!.next('group.ended')).toMatchObject({ reason: 'removed' });
    expect(await removed!.closed()).toMatchObject({ code: 4004 });
    await group.leader.next('codes.updated');
    group.leader.send({ type: 'group.end' });
    await group.leader.next('group.ended');
    expect(await kept!.next('group.ended')).toMatchObject({ reason: 'ended_by_leader' });
    // B's sessions no longer hold the group: a leave says so.
    kept!.send({ type: 'group.leave' });
    expect(await kept!.next('error')).toMatchObject({ code: 'NOT_IN_GROUP' });
  });

  it('roster, vice, a keep-alive prompt, pause and resume and leader changes reach the other instance', async () => {
    // One clock per instance, kept in step, except while the keep-alive
    // prompt is due on A only: then only A can claim the timer, so the
    // prompt to the leader on B crosses instances.
    const clockA = new ManualScheduler();
    const clockB = new ManualScheduler();
    cluster = await startCluster({
      perNode: (index) => ({ scheduler: index === 0 ? clockA : clockB }),
    });
    // The handoff below picks a member on A only once B knows A is live.
    await cluster.converged();
    const [a, b] = cluster.nodes;
    const group = await groupAcross(b!.ts, [a!.ts, a!.ts]);
    const [vice, other] = group.members as [TestClient, TestClient];
    const seen = (client: TestClient, type: string) =>
      client.received.filter((f) => f.type === type);

    // Roster: the leader on B sees both joins made on A.
    await waitUntil(() =>
      group.memberIds.every((id) =>
        group.leader.rosterFrames.some(
          (f) => f.type === 'roster.updated' && f.participant.participantId === id,
        ),
      ),
    );

    // Vice: set on B, told to the member on A.
    group.leader.send({ type: 'vice.set', participantId: group.memberIds[0] });
    await group.leader.next('vice.updated');
    await waitUntil(() => seen(vice, 'vice.changed').length === 1);
    expect(seen(vice, 'vice.changed')[0]).toMatchObject({ isVice: true });

    // Lifecycle prompt: the keep-alive timer fires on A, the leader is on B.
    clockA.advance(PROMPT_AFTER);
    expect(await group.leader.next('keepalive.prompt', 5_000)).toMatchObject({
      groupId: group.groupId,
      countdownMs: COUNTDOWN,
    });
    expect(claims(a!.ts, 'keepAlivePrompt')).toBe(1);
    expect(claims(b!.ts, 'keepAlivePrompt')).toBe(0);
    clockB.advance(PROMPT_AFTER);
    group.leader.send({ type: 'keepalive.ack' });
    await group.leader.next('activity.ack');
    await group.leader.next('keepalive.cleared');

    // Pause and resume: the leader drops and comes back on B.
    group.leader.terminate();
    await waitUntil(() => [vice, other].every((m) => seen(m, 'leader.offline').length === 1));
    for (const member of [vice, other]) {
      expect(seen(member, 'leader.offline')[0]).toMatchObject({ cause: 'disconnected' });
    }
    const back = await b!.ts.connectReady();
    back.send({ type: 'group.resume', token: group.leaderToken });
    await back.next('group.resumed');
    await waitUntil(() => [vice, other].every((m) => seen(m, 'leader.online').length === 1));

    // A handoff fired on B: the vice and the other member on A are told.
    back.terminate();
    await waitUntil(() => [vice, other].every((m) => seen(m, 'leader.offline').length === 2));
    clockB.advance(GRACE);
    await waitUntil(() => claims(b!.ts, 'grace') === 1, 5_000);
    clockA.advance(GRACE);
    await waitUntil(() => seen(vice, 'leader.granted').length === 1, 5_000);
    expect(seen(vice, 'leader.granted')[0]).toMatchObject({ reason: 'handoff_disconnect' });
    await waitUntil(() => seen(other, 'leader.changed').length === 1);
    expect(seen(other, 'leader.changed')[0]).toMatchObject({ reason: 'handoff_disconnect' });

    // A take-back on B: the displaced vice and the other member on A are told.
    const again = await b!.ts.connectReady();
    again.send({ type: 'group.resume', token: group.leaderToken });
    await waitUntil(() => seen(again, 'takeback.offered').length === 1, 5_000);
    again.send({ type: 'leader.takeBack', reqId: 't' });
    await waitUntil(() => seen(again, 'leader.granted').length === 1, 5_000);
    expect(seen(again, 'leader.granted')[0]).toMatchObject({ reqId: 't', reason: 'take_back' });
    await waitUntil(() => seen(vice, 'leader.lost').length === 1, 5_000);
    expect(seen(vice, 'leader.lost')[0]).toMatchObject({ reason: 'take_back' });
    await waitUntil(() => seen(other, 'leader.changed').length === 2);
    expect(seen(other, 'leader.changed')[1]).toMatchObject({ reason: 'take_back' });
  });

  it('a resume on A replaces the session on B, which then acts as nobody (C14)', async () => {
    cluster = await startCluster();
    const [a, b] = cluster.nodes;
    const group = await groupAcross(b!.ts, [a!.ts]);
    const oldLeader = group.leader;
    const fresh = await a!.ts.connectReady();
    fresh.send({ type: 'group.resume', token: group.leaderToken });
    expect(await fresh.next('group.resumed')).toMatchObject({ groupId: group.groupId });
    expect(await oldLeader.next('group.ended')).toMatchObject({ reason: 'replaced' });
    oldLeader.send({ type: 'group.end' });
    expect(await oldLeader.next('error')).toMatchObject({ code: 'NOT_IN_GROUP' });
    expect(group.members[0]!.isClosed).toBe(false);
  });

  it('drops injected effects that match no local session (P2-4)', async () => {
    cluster = await startCluster();
    const [a, b] = cluster.nodes;
    const group = await groupAcross(a!.ts, [b!.ts]);
    const reg = await registry(cluster.prefix, group.groupId);
    const entry = reg.a[group.memberIds[0]!]!;
    const channel = `${cluster.prefix}:v1:ch:${entry.i}`;
    const base = { ns: 'app-a', gid: group.groupId, pid: group.memberIds[0] };
    const frame = JSON.stringify({
      type: 'group.ended',
      groupId: group.groupId,
      reason: 'removed',
    });
    // A current sequence: later real commits still go above it.
    const s = Date.now() * 1000;
    for (const effect of [
      { op: 'deliver', ...base, att: 'B'.repeat(22), text: frame, later: false },
      { op: 'detach', ...base, att: 'B'.repeat(22), reason: 'removed', text: frame, close: 4004 },
      { op: 'deliver', ...base, gid: 'H'.repeat(43), att: entry.t, text: frame, later: false },
      { op: 'settle', ns: 'app-a', gid: group.groupId, rid: 'R'.repeat(22), text: frame },
    ]) {
      await inspect.client.publish(channel, JSON.stringify({ v: 1, s, effects: [effect] }));
    }
    await inspect.client.publish(channel, '{"v":1,"effects":"nope"}');
    await waitUntil(() => b!.ts.logs.find('pubsub_message_invalid') !== undefined);
    await group.members[0]!.expectNoMessage(200);
    expect(group.members[0]!.isClosed).toBe(false);
    expect(b!.ts.logs.text).not.toContain(frame);
    // The member is still in the group: a real move arrives.
    group.leader.send({ type: 'position.update', position: { page: 9 } });
    expect(await group.members[0]!.next('position.updated')).toMatchObject({
      position: { page: 9 },
    });
  });

  it('a task waits for earlier effects published to its instance (Gate 2 Q-B10)', async () => {
    cluster = await startCluster();
    const [, b] = cluster.nodes;
    const group = await groupAcross(b!.ts, [b!.ts]);
    const member = group.members[0]!;
    const reg = await registry(cluster.prefix, group.groupId);
    const entry = reg.a[group.memberIds[0]!]!;
    const prefix = cluster.prefix;
    // An earlier commit (seq) published a move to page 5 for B; it is late.
    const seq = Date.now() * 1000 + 1_000_000_000;
    await inspect.client.hSet(`${prefix}:v1:q:app-a:${group.groupId}`, entry.i, String(seq));
    group.leader.send({ type: 'position.update', position: { page: 6 } });
    await sleep(200);
    const late = {
      op: 'deliver',
      ns: 'app-a',
      gid: group.groupId,
      pid: group.memberIds[0],
      att: entry.t,
      text: JSON.stringify({
        type: 'position.updated',
        groupId: group.groupId,
        position: { page: 5 },
      }),
      later: false,
    };
    await inspect.client.publish(
      `${prefix}:v1:ch:${entry.i}`,
      JSON.stringify({ v: 1, s: seq, effects: [late] }),
    );
    const pages: unknown[] = [];
    for (let i = 0; i < 2; i++) {
      const frame = await member.next('position.updated');
      pages.push((frame.position as { page: number }).page);
    }
    expect(pages).toEqual([5, 6]);
    // Anything older than what arrived is stale and dropped.
    await inspect.client.publish(
      `${prefix}:v1:ch:${entry.i}`,
      JSON.stringify({ v: 1, s: seq - 1, effects: [late] }),
    );
    await waitUntil(() => b!.ts.logs.find('pubsub_message_stale') !== undefined);
    await member.expectNoMessage(100);
  });

  it("a lagging link resyncs: the instance's group sessions close with 1001", async () => {
    cluster = await startCluster();
    const [, b] = cluster.nodes;
    const group = await groupAcross(b!.ts, [b!.ts]);
    const reg = await registry(cluster.prefix, group.groupId);
    const id = reg.a[group.leaderId]!.i;
    // A mark nothing will ever reach.
    const seq = Date.now() * 1000 + 1_000_000_000;
    await inspect.client.hSet(`${cluster.prefix}:v1:q:app-a:${group.groupId}`, id, String(seq));
    group.leader.send({ type: 'position.update', position: { page: 2 } });
    expect(await group.members[0]!.closed()).toMatchObject({ code: 1001 });
    expect(b!.ts.logs.find('pubsub_barrier_timeout')).toBeDefined();
    expect(b!.ts.logs.find('pubsub_resync')).toMatchObject({ sessions: 2 });
  });

  it('a stalled subscriber link is found by its probe and replaced (C15, F20)', async () => {
    cluster = await startCluster();
    const [a, b] = cluster.nodes;
    const group = await groupAcross(a!.ts, [b!.ts]);
    // B's second connection is its subscriber link: stall it only.
    expect(b!.proxy.connections).toBe(2);
    b!.proxy.stallConnection(1);
    expect(await group.members[0]!.closed()).toMatchObject({ code: 1001 });
    expect(b!.ts.logs.find('pubsub_link_lost')).toMatchObject({ cause: 'stalled' });
    // A new link serves again: a member joins on B and gets moves from A.
    await waitUntil(() => {
      const status = b!.ts.server.storage();
      return status.kind === 'redis' && status.state === 'connected';
    }, 5_000);
    const again = await b!.ts.connectReady();
    again.send({ type: 'group.resume', token: group.memberTokens[0] });
    await again.next('group.joined');
    group.leader.send({ type: 'position.update', position: { page: 4 } });
    expect(await again.next('position.updated')).toMatchObject({ position: { page: 4 } });
  });
});
