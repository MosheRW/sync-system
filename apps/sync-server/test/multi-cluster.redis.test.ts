import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { type TestCluster, FAST_TIMINGS, startCluster } from './helpers/cluster.js';
import { type TestGroup, codesOf } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { TEST_REDIS_URL, describeRedis, inspector } from './helpers/redis.js';
import type { TestClient } from './helpers/test-client.js';
import { KEY_A, type TestServer, httpGet } from './helpers/test-server.js';
import { sleep, waitUntil } from './helpers/wait.js';

const MINUTE = 60_000;

interface Registry {
  a: Record<string, { i: string; t: string }>;
}

describeRedis(
  'several instances on one Redis (#35 AC6, AC16, AC18, AC19, AC22, AC24, AC25)',
  () => {
    vi.setConfig({ testTimeout: 30_000 });
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

    async function groupAcross(
      leaderOn: TestServer,
      membersOn: TestServer[],
      create: Record<string, unknown> = {},
    ): Promise<TestGroup> {
      const leader = await leaderOn.connectReady();
      leader.send({ type: 'group.create', metadata: { contentId: 'c' }, ...create });
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

    async function doc(groupId: string) {
      const raw = await inspect.client.get(`${cluster!.prefix}:v1:g:app-a:${groupId}`);
      return raw === null
        ? undefined
        : (JSON.parse(raw) as {
            record: { leaderId: string; participantIds: string[]; leaderOnline: boolean };
          });
    }

    it('three instances start at once and serve one group together (AC6)', async () => {
      cluster = await startCluster({ size: 0 });
      await Promise.all([cluster.add(), cluster.add(), cluster.add()]);
      const [a, b, c] = cluster.nodes;
      for (const node of cluster.nodes) {
        expect(node.ts.server.storage()).toEqual({ kind: 'redis', state: 'connected' });
        expect(node.ts.logs.find('startup_sweep')).toBeDefined();
      }
      const group = await groupAcross(a!.ts, [b!.ts, c!.ts]);
      group.leader.send({ type: 'position.update', position: { page: 2 } });
      await group.leader.next('position.ack');
      for (const member of group.members) {
        expect(await member.next('position.updated')).toMatchObject({ position: { page: 2 } });
      }
    });

    it('joins by every code type on another instance, and codes stay unique under collisions (AC16)', async () => {
      let draws = 0;
      // Every draw collides with one of 4 values: claims race across instances.
      const codeRandom = (max: number) => (draws++ % 4) % max;
      cluster = await startCluster({
        apps: [{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ['A', 'C', 'D'] }],
        codeRandom,
      });
      const [a, b] = cluster.nodes;
      const leader = await a!.ts.connectReady();
      leader.send({ type: 'group.create', metadata: {}, joinMethods: ['A', 'C', 'D'] });
      const created = await leader.next('group.created');
      const byGroupCode = await b!.ts.connectReady();
      byGroupCode.send({
        type: 'group.joinByCode',
        joinCode: created.codes.groupCode,
        doorCode: created.codes.doorCode,
      });
      expect(await byGroupCode.next('group.joined')).toMatchObject({ groupId: created.groupId });
      const byAlpha = await b!.ts.connectReady();
      byAlpha.send({ type: 'group.joinByCode', joinCode: created.codes.alphaCode });
      expect(await byAlpha.next('group.joined')).toMatchObject({ groupId: created.groupId });
      leader.send({ type: 'qr.issue' });
      const { ticket } = await leader.next('qr.ticket');
      const byQr = await b!.ts.connectReady();
      byQr.send({ type: 'group.joinByQr', ticket });
      expect(await byQr.next('group.joined')).toMatchObject({ groupId: created.groupId });
      // 2 instances x 20 creates at once with colliding draws.
      const leaders = await Promise.all(
        Array.from({ length: 40 }, (_v, i) => cluster!.nodes[i % 2]!.ts.connectReady()),
      );
      for (const l of leaders)
        l.send({ type: 'group.create', metadata: {}, joinMethods: ['A', 'C'] });
      const replies = await Promise.all(leaders.map((l) => l.next()));
      const groups = replies.filter((r) => r.type === 'group.created');
      expect(groups.length).toBeGreaterThan(0);
      const holders = new Map<string, string>();
      for (const key of await inspect.keys(`${cluster.prefix}:v1:c`)) {
        const holder = (await inspect.client.get(key))!;
        expect(holders.get(key)).toBeUndefined();
        holders.set(key, holder);
      }
      const codes = new Set<string>();
      for (const r of groups) {
        if (r.type !== 'group.created') continue;
        for (const code of [r.codes.groupCode, r.codes.alphaCode]) {
          expect(codes.has(code!)).toBe(false);
          codes.add(code!);
        }
      }
      for (const r of replies) {
        if (r.type !== 'group.created') expect(r).toMatchObject({ code: 'CODES_EXHAUSTED' });
      }
    });

    it('exactly one wins the last slot and the same leader token on two instances (AC18)', async () => {
      cluster = await startCluster({
        apps: [{ namespace: 'app-a', apiKey: KEY_A, maxGroupSize: 2 }],
      });
      const [a, b] = cluster.nodes;
      for (let round = 0; round < 5; round++) {
        const group = await groupAcross(a!.ts, []);
        const joiners = await Promise.all([a!.ts.connectReady(), b!.ts.connectReady()]);
        for (const j of joiners) j.send({ type: 'group.joinByCode', ...group.join });
        const replies = await Promise.all(joiners.map((j) => j.next()));
        expect(replies.filter((r) => r.type === 'group.joined')).toHaveLength(1);
        expect(replies.filter((r) => r.type === 'error' && r.code === 'GROUP_FULL')).toHaveLength(
          1,
        );
        // Two resumes of the leader token at once: exactly one leads.
        group.leader.terminate();
        const resumers = await Promise.all([a!.ts.connectReady(), b!.ts.connectReady()]);
        for (const r of resumers) r.send({ type: 'group.resume', token: group.leaderToken });
        await Promise.all(resumers.map((r) => r.next('group.resumed')));
        await sleep(200);
        const replaced = resumers.filter((r) =>
          r.received.some((f) => f.type === 'group.ended' && f.reason === 'replaced'),
        );
        expect(replaced).toHaveLength(1);
        const stored = await doc(group.groupId);
        expect(stored?.record.leaderOnline).toBe(true);
        const reg = JSON.parse(
          (await inspect.client.get(`${cluster.prefix}:v1:a:app-a:${group.groupId}`))!,
        ) as Registry;
        expect(Object.keys(reg.a)).toContain(group.leaderId);
      }
    });

    it("a commit whose lease lapsed aborts; the other instance's write stands (AC18 fence)", async () => {
      let delayNext = false;
      cluster = await startCluster({
        redisTimings: {
          ...FAST_TIMINGS,
          leaseMs: 300,
          renewMs: 100,
          maxHoldMs: 150,
          waitMs: 3_000,
        },
        perNode: (index) =>
          index === 0
            ? {
                beforeCommit: async () => {
                  if (!delayNext) return;
                  delayNext = false;
                  await sleep(800);
                },
              }
            : {},
      });
      const [a, b] = cluster.nodes;
      const group = await groupAcross(a!.ts, [b!.ts], { position: { page: 1 } });
      const [onB] = group.members;
      delayNext = true;
      group.leader.send({ type: 'position.update', position: { page: 2 } });
      await sleep(100);
      // B writes while A's commit waits past its lease.
      onB!.send({ type: 'group.leave' });
      expect(await onB!.next('group.left', 5_000)).toBeDefined();
      const afterB = await inspect.client.get(`${cluster.prefix}:v1:g:app-a:${group.groupId}`);
      // A's late commit aborts: its sessions of the group close with 1001.
      expect(await group.leader.closed()).toMatchObject({ code: 1001 });
      expect(a!.ts.logs.find('group_lease_lost')).toBeDefined();
      expect(await inspect.client.get(`${cluster.prefix}:v1:g:app-a:${group.groupId}`)).toBe(
        afterB,
      );
      const pos = await inspect.client.get(`${cluster.prefix}:v1:p:app-a:${group.groupId}`);
      expect(pos).not.toContain('"page":2');
    });

    it('a timer fires once with three instances, and again elsewhere if its claimer stalls (AC19)', async () => {
      const scheduler = new ManualScheduler();
      let stall = false;
      let stalled: number | undefined;
      let release: (() => void) | undefined;
      cluster = await startCluster({
        size: 3,
        scheduler,
        apps: [{ namespace: 'app-a', apiKey: KEY_A, maxSessionMinutes: 5 }],
        redisTimings: {
          ...FAST_TIMINGS,
          timerLeaseMs: 10_000,
          leaseMs: 300,
          renewMs: 100,
          maxHoldMs: 150,
          waitMs: 3_000,
        },
        perNode: (index) => ({
          beforeCommit: async () => {
            if (!stall) return;
            stall = false;
            stalled = index;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          },
        }),
      });
      const [a, b, c] = cluster.nodes;
      const first = await groupAcross(a!.ts, [b!.ts, c!.ts]);
      scheduler.advance(5 * MINUTE);
      for (const client of [first.leader, ...first.members]) {
        expect(await client.next('group.ended', 5_000)).toMatchObject({ reason: 'max_session' });
      }
      await sleep(300);
      for (const client of [first.leader, ...first.members]) {
        expect(client.received.filter((f) => f.type === 'group.ended')).toHaveLength(1);
      }
      // The first claimer of the next group's timer stalls in its commit and
      // is then partitioned: after the timer lease another instance fires it.
      const second = await groupAcross(c!.ts, [b!.ts, a!.ts]);
      stall = true;
      scheduler.advance(5 * MINUTE);
      await waitUntil(() => release !== undefined, 5_000);
      const claimer = cluster.nodes[stalled!]!;
      claimer.proxy.cut();
      scheduler.advance(10_000);
      const survivors = [second.leader, ...second.members].filter(
        (_client, i) => [c, b, a][i] !== claimer,
      );
      for (const client of survivors) {
        expect(await client.next('group.ended', 8_000)).toMatchObject({ reason: 'max_session' });
      }
      release?.();
    });

    it('limits: connections per instance; door failures add up across instances (AC22)', async () => {
      cluster = await startCluster({
        env: {
          MAX_CONNECTIONS: '2',
          MAX_APP_CONNECTIONS_CEILING: '2',
          MAX_PENDING_HANDSHAKES: '2',
        },
      });
      const [a, b] = cluster.nodes;
      const open = await Promise.all([
        a!.ts.connect(),
        a!.ts.connect(),
        b!.ts.connect(),
        b!.ts.connect(),
      ]);
      await expect(a!.ts.connect()).rejects.toThrow();
      await expect(b!.ts.connect()).rejects.toThrow();
      for (const client of open) client.terminate();
      await waitUntil(() => a!.ts.server.stats().total === 0 && b!.ts.server.stats().total === 0);
      const group = await groupAcross(a!.ts, []);
      const wrong = async (ts: TestServer) => {
        const guesser = await ts.connectReady();
        guesser.send({
          type: 'group.joinByCode',
          joinCode: group.join.joinCode,
          doorCode: '000000',
        });
        await guesser.next('error');
        guesser.terminate();
      };
      for (let i = 0; i < 3; i++) await wrong(a!.ts);
      for (let i = 0; i < 2; i++) await wrong(b!.ts);
      expect(await group.leader.next('codes.updated')).toMatchObject({ reason: 'door_failures' });
    });

    it('every key of a several-instance group is bounded and goes with the group (AC24)', async () => {
      cluster = await startCluster({
        apps: [
          {
            namespace: 'app-a',
            apiKey: KEY_A,
            joinMethods: ['B', 'D'],
            approvalTimeoutSeconds: 60,
          },
        ],
      });
      const [a, b] = cluster.nodes;
      const leader = await a!.ts.connectReady();
      leader.send({ type: 'group.create', metadata: {}, joinMethods: ['B'] });
      const created = await leader.next('group.created');
      const asker = await b!.ts.connectReady();
      asker.send({
        type: 'group.joinByCode',
        joinCode: created.codes.groupCode,
        displayName: 'Kim',
      });
      const { requestId } = await asker.next('join.pending');
      await leader.next('join.requested');
      const other = await b!.ts.connectReady();
      other.send({ type: 'group.joinByCode', joinCode: created.codes.groupCode });
      const pending = await other.next('join.pending');
      await leader.next('join.requested');
      leader.send({ type: 'join.approve', requestId: pending.requestId });
      await leader.next('join.decided');
      await other.next('group.joined');
      const end = 180 * MINUTE + 5000;
      for (const key of await inspect.keys(cluster.prefix)) {
        const ttl = await inspect.client.pTTL(key);
        expect(ttl, key).toBeGreaterThan(0);
        if (key.endsWith(':insts') || key.endsWith(':seq')) {
          expect(ttl, key).toBeLessThanOrEqual(24 * 60 * MINUTE);
        } else if (key.includes(':inst:')) expect(ttl, key).toBeLessThanOrEqual(1_500);
        else if (key.includes(`:ap:`)) expect(ttl, key).toBeLessThanOrEqual(60_000);
        else if (key.includes(':lock:')) expect(ttl, key).toBeLessThanOrEqual(1_000);
        else expect(ttl, key).toBeLessThanOrEqual(key.endsWith(':epoch') ? end + 5 * MINUTE : end);
      }
      expect(
        await inspect.client.exists(
          `${cluster.prefix}:v1:ap:app-a:${created.groupId}:${requestId}`,
        ),
      ).toBe(1);
      leader.send({ type: 'group.end' });
      await leader.next('group.ended');
      await asker.next('error');
      const left = (await inspect.keys(cluster.prefix)).filter((k) => k.includes(created.groupId));
      expect(left).toEqual([]);
      for (const key of await inspect.keys(`${cluster.prefix}:v1:ig`)) {
        expect(await inspect.client.sIsMember(key, `app-a:${created.groupId}`)).toBeFalsy();
      }
    });

    it('logs nothing personal or secret across fence, sweep, resync and dropped effects (AC25)', async () => {
      cluster = await startCluster({
        apps: [{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ['B', 'D'] }],
      });
      const [a, b] = cluster.nodes;
      const leader = await b!.ts.connectReady();
      leader.send({
        type: 'group.create',
        metadata: {},
        joinMethods: ['B'],
        displayName: 'Leader Lu',
      });
      const created = await leader.next('group.created');
      const asker = await a!.ts.connectReady();
      asker.send({
        type: 'group.joinByCode',
        joinCode: created.codes.groupCode,
        displayName: 'Secret Sam',
      });
      const { requestId } = await asker.next('join.pending');
      await leader.next('join.requested');
      leader.send({ type: 'join.approve', requestId });
      const joined = await asker.next('group.joined');
      const reg = JSON.parse(
        (await inspect.client.get(`${cluster.prefix}:v1:a:app-a:${created.groupId}`))!,
      ) as Registry;
      const ids = [...new Set(Object.values(reg.a).map((e) => e.i))];
      const attachIds = Object.values(reg.a).map((e) => e.t);
      await inspect.client.publish(
        `${cluster.prefix}:v1:ch:${ids[0]!}`,
        '{"v":1,"s":1,"effects":[]}',
      );
      a!.proxy.cut();
      await asker.closed();
      await waitUntil(() => b!.ts.logs.find('orphan_sweep') !== undefined, 10_000);
      const forbidden = [
        created.groupId,
        created.participantId,
        joined.participantId,
        requestId,
        created.codes.groupCode!,
        'Secret Sam',
        'Leader Lu',
        cluster.prefix,
        new URL(TEST_REDIS_URL!).password || 'unused-sentinel',
        ...ids,
        ...attachIds,
      ];
      for (const node of [a!, b!]) {
        for (const secret of forbidden) expect(node.ts.logs.text).not.toContain(secret);
      }
      expect(a!.ts.logs.find('instance_fenced')).toBeDefined();
    });

    it('an instance paused past its self-fence takes no lease and writes nothing as its old ID (C11)', async () => {
      let clock = 0;
      cluster = await startCluster({
        perNode: (index) => (index === 0 ? { monotonic: () => clock } : {}),
        redisTimings: { ...FAST_TIMINGS, heartbeatMs: 60_000 },
      });
      const [a, b] = cluster.nodes;
      const group = await groupAcross(b!.ts, []);
      const joiner = await a!.ts.connectReady();
      clock += 10_000;
      joiner.send({ type: 'group.joinByCode', ...group.join });
      expect(await joiner.closed()).toMatchObject({ code: 1001 });
      const raw = await inspect.client.get(`${cluster.prefix}:v1:a:app-a:${group.groupId}`);
      const reg = JSON.parse(raw!) as Registry;
      expect(Object.keys(reg.a)).toEqual([group.leaderId]);
      expect((await doc(group.groupId))?.record.participantIds).toEqual([group.leaderId]);
      expect((await httpGet(a!.ts.port, '/health')).status).toBe(200);
    });

    it('a session replaced elsewhere whose detach was lost acts as nobody (C14, F19)', async () => {
      cluster = await startCluster({
        redisTimings: {
          ...FAST_TIMINGS,
          heartbeatMs: 60_000,
          livenessMs: 120_000,
          selfFenceMs: 90_000,
        },
      });
      const [a, b] = cluster.nodes;
      const group = await groupAcross(b!.ts, [a!.ts], { position: { page: 1 } });
      // B's subscriber link (its second connection) silently stops delivering.
      b!.proxy.stallConnection(1);
      const fresh = await a!.ts.connectReady();
      fresh.send({ type: 'group.resume', token: group.leaderToken });
      await fresh.next('group.resumed');
      // The lost detach would make B's next task wait and resync (Q-B10);
      // without the mark, the registry check alone must deny (C14).
      const reg = JSON.parse(
        (await inspect.client.get(`${cluster.prefix}:v1:a:app-a:${group.groupId}`))!,
      ) as Registry;
      const aId = reg.a[group.leaderId]!.i;
      for (const field of await inspect.client.hKeys(
        `${cluster.prefix}:v1:q:app-a:${group.groupId}`,
      )) {
        if (field !== aId)
          await inspect.client.hDel(`${cluster.prefix}:v1:q:app-a:${group.groupId}`, field);
      }
      const stale = group.leader;
      for (const message of [
        { type: 'position.update', position: { page: 9 } },
        { type: 'group.end' },
        { type: 'group.lock' },
        { type: 'qr.issue' },
      ]) {
        stale.send(message);
        expect(await stale.next('error')).toMatchObject({ code: 'NOT_IN_GROUP' });
      }
      expect((await doc(group.groupId))?.record.leaderOnline).toBe(true);
      fresh.send({ type: 'position.update', position: { page: 2 } });
      await fresh.next('position.ack');
      expect(await group.members[0]!.next('position.updated')).toMatchObject({
        position: { page: 2 },
      });
    });
  },
);
