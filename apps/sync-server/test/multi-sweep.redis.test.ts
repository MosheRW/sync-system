import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { type TestCluster, FAST_TIMINGS, startCluster } from './helpers/cluster.js';
import { type TestGroup, codesOf } from './helpers/groups.js';
import { describeRedis, inspector } from './helpers/redis.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, type TestServer } from './helpers/test-server.js';
import { sleep, waitUntil } from './helpers/wait.js';

const APPS = [{ namespace: 'app-a', apiKey: KEY_A, disconnectGraceSeconds: 2 }];

describeRedis(
  'stopped and dead instances are swept (#35 AC21, architecture 12.8, C12, C13)',
  () => {
    vi.setConfig({ testTimeout: 20_000 });
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

    async function storedRecord(groupId: string) {
      const raw = await inspect.client.get(`${cluster!.prefix}:v1:g:app-a:${groupId}`);
      return (JSON.parse(raw!) as { record: { leaderOnline: boolean; participantIds: string[] } })
        .record;
    }

    it('a clean stop: the leader goes offline with the normal grace and resumes on B with the lead', async () => {
      cluster = await startCluster({ apps: APPS });
      const [a, b] = cluster.nodes;
      const group = await groupAcross(a!.ts, [b!.ts, a!.ts]);
      const [onB] = group.members;
      await cluster.stop(a!);
      // B's sweep runs within a tick: B's member sees the leader go offline.
      expect(await onB!.next('leader.offline', 5_000)).toMatchObject({ cause: 'disconnected' });
      const record = await storedRecord(group.groupId);
      expect(record.leaderOnline).toBe(false);
      expect(record.participantIds).toEqual([group.leaderId, group.memberIds[0]]);
      // The leader resumes on B within the grace: it keeps the lead.
      const leader = await b!.ts.connectReady();
      leader.send({ type: 'group.resume', token: group.leaderToken });
      expect(await leader.next('group.resumed')).toMatchObject({ recreated: false });
      expect(await onB!.next('leader.online')).toBeDefined();
      // A's member resumes on B too.
      const back = await b!.ts.connectReady();
      back.send({ type: 'group.resume', token: group.memberTokens[1] });
      expect(await back.next('group.joined')).toMatchObject({ groupId: group.groupId });
      expect(b!.ts.logs.find('orphan_sweep')).toMatchObject({ instances: 1, groups: 1 });
    });

    it('a stopped leader that does not come back hands off only after the grace (AC21)', async () => {
      cluster = await startCluster({ apps: APPS });
      const [a, b] = cluster.nodes;
      const group = await groupAcross(a!.ts, [b!.ts]);
      const [onB] = group.members;
      await cluster.stop(a!);
      await onB!.next('leader.offline', 5_000);
      const offlineAt = Date.now();
      expect(await onB!.next('leader.granted', 5_000)).toMatchObject({
        reason: 'handoff_disconnect',
      });
      expect(Date.now() - offlineAt).toBeGreaterThanOrEqual(1_500);
    });

    it('a partitioned instance fences itself before its peer sweeps it', async () => {
      cluster = await startCluster({ apps: APPS });
      const [a, b] = cluster.nodes;
      const group = await groupAcross(a!.ts, [b!.ts, a!.ts]);
      const [onB, onA] = group.members;
      a!.proxy.cut();
      // A closes its own group sessions (dropped channel or fence) ...
      expect(await group.leader.closed()).toMatchObject({ code: 1001 });
      expect(await onA!.closed()).toMatchObject({ code: 1001 });
      await waitUntil(() => a!.ts.logs.find('instance_fenced') !== undefined, 5_000);
      const fencedAt = Number(a!.ts.logs.find('instance_fenced')!.time);
      // ... and only then may B treat it as dead and sweep it.
      expect(await onB!.next('leader.offline', 8_000)).toBeDefined();
      const sweptAt = Date.now();
      expect(fencedAt).toBeLessThan(sweptAt);
      const record = await storedRecord(group.groupId);
      expect(record.participantIds).toEqual([group.leaderId, group.memberIds[0]]);
      expect(record.leaderOnline).toBe(false);
    });

    it('an instance that registered just before a sweep keeps its participants (C12)', async () => {
      cluster = await startCluster({ apps: APPS, size: 3 });
      const [a, b, c] = cluster.nodes;
      const group = await groupAcross(b!.ts, [a!.ts]);
      // A newcomer joins on C, then A stops: B and C sweep A.
      const late = await c!.ts.connectReady();
      late.send({ type: 'group.joinByCode', ...group.join });
      await late.next('group.joined');
      await cluster.stop(a!);
      await waitUntil(
        () =>
          b!.ts.logs.find('orphan_sweep') !== undefined ||
          c!.ts.logs.find('orphan_sweep') !== undefined,
        8_000,
      );
      await sleep(300);
      group.leader.send({ type: 'position.update', position: { page: 3 } });
      expect(await late.next('position.updated')).toMatchObject({ position: { page: 3 } });
      expect(late.isClosed).toBe(false);
    });

    it("a short Redis blip on B replays only B's own disconnects; A's participants stay (C13, F18)", async () => {
      cluster = await startCluster({
        apps: APPS,
        redisTimings: { ...FAST_TIMINGS, livenessMs: 8_000, selfFenceMs: 6_000 },
      });
      const [a, b] = cluster.nodes;
      const group = await groupAcross(a!.ts, [a!.ts, b!.ts]);
      const [onA, onB] = group.members;
      b!.proxy.cut();
      // B's sessions close; their disconnects wait for Redis (replay queue).
      expect(await onB!.closed()).toMatchObject({ code: 1001 });
      await sleep(1_500);
      b!.proxy.restore();
      await waitUntil(
        async () =>
          !(await storedRecord(group.groupId)).participantIds.includes(group.memberIds[1]!),
        10_000,
      );
      const record = await storedRecord(group.groupId);
      expect(record.leaderOnline).toBe(true);
      expect(record.participantIds).toEqual([group.leaderId, group.memberIds[0]]);
      // A's member saw no leader change, and still gets moves.
      group.leader.send({ type: 'position.update', position: { page: 8 } });
      expect(await onA!.next('position.updated')).toMatchObject({ position: { page: 8 } });
      expect(onA!.received.some((f) => f.type === 'leader.offline')).toBe(false);
    }, 20_000);
  },
);
