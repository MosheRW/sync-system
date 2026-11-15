import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { type TestCluster, startCluster } from './helpers/cluster.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { describeRedis, inspector } from './helpers/redis.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, type TestServer } from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

const APPS = [
  {
    namespace: 'app-a',
    apiKey: KEY_A,
    joinMethods: ['B', 'C', 'D'],
    approvalTimeoutSeconds: 15,
    disconnectGraceSeconds: 2,
  },
];

describeRedis('method B approvals across instances (#35 AC7, AC20, architecture 12.9)', () => {
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

  async function leaderOn(ts: TestServer): Promise<{
    leader: TestClient;
    groupId: string;
    groupCode: string;
    token: string;
  }> {
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: { contentId: 'c' }, joinMethods: ['B'] });
    const created = await leader.next('group.created');
    return {
      leader,
      groupId: created.groupId,
      groupCode: created.codes.groupCode!,
      token: created.token,
    };
  }

  async function ask(
    ts: TestServer,
    groupCode: string,
    displayName?: string,
  ): Promise<{ joiner: TestClient; requestId: string }> {
    const joiner = await ts.connectReady();
    joiner.send({
      type: 'group.joinByCode',
      joinCode: groupCode,
      ...(displayName === undefined ? {} : { displayName }),
    });
    const pending = await joiner.next('join.pending');
    return { joiner, requestId: pending.requestId };
  }

  it('approve: the joiner on B is admitted, the leader on A sees admitted (AC20)', async () => {
    cluster = await startCluster({ apps: APPS });
    const [a, b] = cluster.nodes;
    const group = await leaderOn(a!.ts);
    const { joiner, requestId } = await ask(b!.ts, group.groupCode, 'Ana');
    expect(await group.leader.next('join.requested')).toMatchObject({
      requestId,
      displayName: 'Ana',
    });
    // The request is a key that lives until its deadline, never past E (AC7).
    const key = `${cluster.prefix}:v1:ap:app-a:${group.groupId}:${requestId}`;
    const ttl = await inspect.client.pTTL(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15_000);
    group.leader.send({ type: 'join.approve', requestId });
    expect(await group.leader.next('join.decided')).toMatchObject({ outcome: 'admitted' });
    const joined = await joiner.next('group.joined');
    expect(joined).toMatchObject({ groupId: group.groupId, displayName: 'Ana' });
    expect(await inspect.client.exists(key)).toBe(0);
    // A real member: it gets moves, and the leader sees it in the roster.
    group.leader.send({ type: 'position.update', position: { page: 2 } });
    await group.leader.next('position.ack');
    expect(await joiner.next('position.updated')).toMatchObject({ position: { page: 2 } });
    // Settled once: a second approve finds nothing.
    group.leader.send({ type: 'join.approve', requestId });
    expect(await group.leader.next('error')).toMatchObject({ code: 'JOIN_REQUEST_NOT_FOUND' });
  });

  it('an invalid stored request is never approvable (C1)', async () => {
    cluster = await startCluster({ apps: APPS });
    const [a, b] = cluster.nodes;
    const group = await leaderOn(a!.ts);
    const { requestId } = await ask(b!.ts, group.groupCode, 'Cy');
    await group.leader.next('join.requested');
    const key = `${cluster.prefix}:v1:ap:app-a:${group.groupId}:${requestId}`;
    await inspect.client.set(key, '{"i":"nope","d":1}', { PX: 10_000 });
    group.leader.send({ type: 'join.approve', requestId });
    expect(await group.leader.next('error')).toMatchObject({ code: 'JOIN_REQUEST_NOT_FOUND' });
    expect(a!.ts.logs.find('store_document_invalid')).toBeDefined();
    expect(await inspect.client.exists(key)).toBe(0);
  });

  it('deny, cancel and a closed joiner settle once each across instances', async () => {
    cluster = await startCluster({ apps: APPS });
    const [a, b] = cluster.nodes;
    const group = await leaderOn(a!.ts);
    const denied = await ask(b!.ts, group.groupCode);
    await group.leader.next('join.requested');
    group.leader.send({ type: 'join.deny', requestId: denied.requestId });
    expect(await group.leader.next('join.decided')).toMatchObject({ outcome: 'denied' });
    expect(await denied.joiner.next('error')).toMatchObject({ code: 'JOIN_DENIED' });

    const cancelled = await ask(b!.ts, group.groupCode);
    await group.leader.next('join.requested');
    cancelled.joiner.send({ type: 'join.cancel' });
    expect(await cancelled.joiner.next('join.cancelled')).toBeDefined();
    expect(await group.leader.next('join.withdrawn')).toMatchObject({
      requestId: cancelled.requestId,
      reason: 'cancelled',
    });

    const closed = await ask(b!.ts, group.groupCode);
    await group.leader.next('join.requested');
    closed.joiner.terminate();
    expect(await group.leader.next('join.withdrawn')).toMatchObject({
      requestId: closed.requestId,
      reason: 'disconnected',
    });
    expect(await inspect.keys(`${cluster.prefix}:v1:ap`)).toEqual([]);
  });

  it("an approval racing the joiner's close: admitted, then removed by the usual rules (Q-B3)", async () => {
    cluster = await startCluster({ apps: APPS });
    const [a, b] = cluster.nodes;
    const group = await leaderOn(a!.ts);
    const { joiner, requestId } = await ask(b!.ts, group.groupCode);
    await group.leader.next('join.requested');
    // B forgets the joiner without telling anyone (its socket is going away).
    joiner.ws.pause();
    joiner.terminate();
    group.leader.send({ type: 'join.approve', requestId });
    const decided = await group.leader.next();
    if (decided.type === 'join.decided' && decided.outcome === 'admitted') {
      // B then finds no waiting session: the member is removed.
      await waitUntil(() =>
        group.leader.rosterFrames.some(
          (f) => f.type === 'roster.updated' && !f.participant.connected,
        ),
      );
    } else {
      // The close won the race: settled as disconnected.
      expect(decided).toMatchObject({ type: 'error', code: 'JOIN_REQUEST_NOT_FOUND' });
    }
    await waitUntil(async () => {
      const raw = await inspect.client.get(`${cluster!.prefix}:v1:g:app-a:${group.groupId}`);
      const doc = JSON.parse(raw!) as { record: { participantIds: string[] } };
      return doc.record.participantIds.length === 1;
    });
  });

  it('an admit for a request nobody waits on never removes an attached member (P2-4)', async () => {
    cluster = await startCluster({ apps: APPS });
    const [a, b] = cluster.nodes;
    const group = await leaderOn(a!.ts);
    const { joiner, requestId } = await ask(b!.ts, group.groupCode);
    await group.leader.next('join.requested');
    group.leader.send({ type: 'join.approve', requestId });
    await group.leader.next('join.decided');
    const joined = await joiner.next('group.joined');
    const raw = await inspect.client.get(`${cluster.prefix}:v1:a:app-a:${group.groupId}`);
    const entry = (JSON.parse(raw!) as { a: Record<string, { i: string; t: string }> }).a[
      joined.participantId
    ]!;
    await inspect.client.publish(
      `${cluster.prefix}:v1:ch:${entry.i}`,
      JSON.stringify({
        v: 1,
        s: Date.now() * 1000,
        effects: [
          {
            op: 'admit',
            ns: 'app-a',
            gid: group.groupId,
            pid: joined.participantId,
            att: entry.t,
            rid: 'Z'.repeat(22),
            text: '{"type":"group.joined"}',
          },
        ],
      }),
    );
    await joiner.expectNoMessage(300);
    group.leader.send({ type: 'position.update', position: { page: 5 } });
    await group.leader.next('position.ack');
    expect(await joiner.next('position.updated')).toMatchObject({ position: { page: 5 } });
  });

  it('the leader back on another instance gets the pending requests again; the end settles them', async () => {
    cluster = await startCluster({ apps: APPS });
    const [a, b] = cluster.nodes;
    const group = await leaderOn(a!.ts);
    const { joiner, requestId } = await ask(b!.ts, group.groupCode, 'Bo');
    await group.leader.next('join.requested');
    group.leader.terminate();
    const leader = await b!.ts.connectReady();
    leader.send({ type: 'group.resume', token: group.token });
    await leader.next('group.resumed');
    expect(await leader.next('join.requested')).toMatchObject({ requestId, displayName: 'Bo' });
    leader.send({ type: 'group.end' });
    await leader.next('group.ended');
    expect(await joiner.next('error')).toMatchObject({ code: 'GROUP_ENDED' });
    // Nothing of the group is left (AC24).
    const keys = await inspect.keys(cluster.prefix);
    expect(keys.filter((k) => k.includes(group.groupId))).toEqual([]);
  });

  it('a timeout settles the joiner on B and tells the leader on A (AC20)', async () => {
    const scheduler = new ManualScheduler();
    cluster = await startCluster({ apps: APPS, scheduler });
    const [a, b] = cluster.nodes;
    const group = await leaderOn(a!.ts);
    const { joiner, requestId } = await ask(b!.ts, group.groupCode);
    await group.leader.next('join.requested');
    scheduler.advance(15_000 + 1);
    expect(await joiner.next('error', 5_000)).toMatchObject({ code: 'APPROVAL_TIMEOUT' });
    expect(await group.leader.next('join.withdrawn', 5_000)).toMatchObject({
      requestId,
      reason: 'timeout',
    });
    expect(await inspect.keys(`${cluster.prefix}:v1:ap`)).toEqual([]);
    expect(await inspect.client.zCard(`${cluster.prefix}:v1:aq:app-a:${group.groupId}`)).toBe(0);
  });
});
