import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createLogger } from '../src/logging/logger.js';
import type { RedisLink } from '../src/storage/redis/connect.js';
import { type FenceReason, RedisInstance, instanceRef } from '../src/storage/redis/instance.js';
import { redisContext } from '../src/storage/redis/redis-storage.js';
import { realScheduler } from '../src/time/scheduler.js';
import { createGroupWithMembers } from './helpers/groups.js';
import { LogCapture } from './helpers/log-capture.js';
import { describeRedis, inspector, randomPrefix, testLink } from './helpers/redis.js';
import { type TestServer, httpGet, startTestServer } from './helpers/test-server.js';
import { waitUntil as waitFor } from './helpers/wait.js';

const TIMINGS = { livenessMs: 900, heartbeatMs: 100, selfFenceMs: 600 };

describeRedis('instances: liveness and self-fencing (#35 architecture 12.5, P2-3, C11)', () => {
  let inspect: Awaited<ReturnType<typeof inspector>>;
  const prefixes: string[] = [];
  const links: RedisLink[] = [];
  const instances: RedisInstance[] = [];
  const servers: TestServer[] = [];

  beforeAll(async () => {
    inspect = await inspector();
  });
  afterAll(() => {
    inspect.close();
  });
  afterEach(async () => {
    for (const instance of instances.splice(0)) await instance.stop();
    for (const ts of servers.splice(0)) await ts.close();
    for (const link of links.splice(0)) await link.close();
    for (const prefix of prefixes.splice(0)) await inspect.flush(prefix);
  });

  async function instanceOn(
    monotonic?: () => number,
  ): Promise<{ instance: RedisInstance; prefix: string; logs: LogCapture }> {
    const prefix = randomPrefix();
    prefixes.push(prefix);
    const logs = new LogCapture();
    const logger = createLogger({ level: 'trace', destination: logs });
    const link = await testLink(prefix, logger);
    links.push(link);
    const ctx = redisContext({
      link,
      keyPrefix: prefix,
      scheduler: realScheduler(),
      logger,
      appOf: () => undefined,
    });
    const instance = new RedisInstance(ctx, TIMINGS, monotonic);
    instances.push(instance);
    return { instance, prefix, logs };
  }

  it('registers a liveness key with a TTL and renews it', async () => {
    const { instance, prefix, logs } = await instanceOn();
    await instance.register();
    instance.start();
    const key = `${prefix}:v1:inst:${instance.id}`;
    expect(instance.id).toMatch(/^[0-9a-f]{32}$/);
    const ttl = await inspect.client.pTTL(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(TIMINGS.livenessMs);
    expect(await inspect.client.zScore(`${prefix}:v1:insts`, instance.id)).not.toBeNull();
    // Renewed well past the first TTL.
    await new Promise((resolve) => setTimeout(resolve, TIMINGS.livenessMs + 300));
    expect(await inspect.client.exists(key)).toBe(1);
    expect(instance.fenced()).toBe(false);
    expect(instance.looksLive(instance.id)).toBe(true);
    // Logs carry the reference only, never the ID (AC25).
    expect(logs.find('instance_registered')).toMatchObject({
      instanceRef: instanceRef(instance.id),
    });
    expect(logs.text).not.toContain(instance.id);
  });

  it('fences when a renewal finds its key gone, then registers under a new ID', async () => {
    const { instance, prefix, logs } = await instanceOn();
    await instance.register();
    const fences: FenceReason[] = [];
    const ids: string[] = [];
    instance.onFence((reason) => fences.push(reason));
    instance.onRegistered((id) => ids.push(id));
    instance.start();
    const first = instance.id;
    await inspect.client.del(`${prefix}:v1:inst:${first}`);
    await waitFor(() => fences.length === 1);
    expect(fences).toEqual(['fenced']);
    expect(logs.find('instance_fenced')).toMatchObject({
      instanceRef: instanceRef(first),
      cause: 'fenced',
    });
    await waitFor(() => ids.length === 1);
    expect(ids[0]).not.toBe(first);
    expect(instance.id).toBe(ids[0]);
    expect(instance.fenced()).toBe(false);
    // The old ID never comes back.
    expect(await inspect.client.exists(`${prefix}:v1:inst:${first}`)).toBe(0);
    expect(await inspect.client.exists(`${prefix}:v1:inst:${instance.id}`)).toBe(1);
  });

  it('fences by silence on the monotonic clock, before its key can expire', async () => {
    let clock = 1_000;
    const { instance, prefix } = await instanceOn(() => clock);
    await instance.register();
    const fences: FenceReason[] = [];
    instance.onFence((reason) => fences.push(reason));
    instance.start();
    // The renewals keep succeeding but none counts once the clock moved past
    // the self-fence bound: a frozen process wakes up fenced (F16).
    clock += TIMINGS.selfFenceMs;
    expect(instance.fenced()).toBe(true);
    await waitFor(() => fences.length === 1);
    expect(fences).toEqual(['silence']);
    // Its key is still there: it fenced before anyone could treat it as dead.
    expect(await inspect.client.exists(`${prefix}:v1:inst:${instance.id}`)).toBe(1);
  });

  it('a clean stop deletes the key and marks the instance for an immediate sweep', async () => {
    const { instance, prefix } = await instanceOn();
    await instance.register();
    const id = instance.id;
    await instance.stop();
    expect(await inspect.client.exists(`${prefix}:v1:inst:${id}`)).toBe(0);
    expect(await inspect.client.zScore(`${prefix}:v1:insts`, id)).toBe(0);
    const { instance: peer } = await instanceOn();
    // A peer on another prefix sees nothing of it (AC5).
    await peer.register();
    expect(await peer.deadInstances()).toEqual([]);
  });

  it('lists dead instances only once their key is gone, and forgets them only then', async () => {
    const { instance: a, prefix } = await instanceOn();
    await a.register();
    const logger = createLogger({ level: 'silent' });
    const link = await testLink(prefix, logger);
    links.push(link);
    const b = new RedisInstance(
      redisContext({
        link,
        keyPrefix: prefix,
        scheduler: realScheduler(),
        logger,
        appOf: () => undefined,
      }),
      TIMINGS,
    );
    instances.push(b);
    await b.register();
    expect(await a.liveOf([a.id, b.id, 'not-an-id'])).toEqual(new Set([a.id, b.id]));
    // Not dead while its key exists, even with its deadline passed.
    await inspect.client.zAdd(`${prefix}:v1:insts`, { score: 0, value: b.id });
    expect(await a.deadInstances()).toEqual([]);
    expect(await a.forget(b.id)).toBe(false);
    const dead = b.id;
    await b.stop();
    expect(await a.deadInstances()).toEqual([dead]);
    expect(await a.liveOf([dead])).toEqual(new Set());
    await inspect.client.sAdd(`${prefix}:v1:ig:${dead}`, 'app-a:x');
    expect(await a.forget(dead)).toBe(true);
    expect(await inspect.client.exists(`${prefix}:v1:ig:${dead}`)).toBe(0);
    expect(await a.deadInstances()).toEqual([]);
  });

  it('a commit after the liveness key is gone writes nothing; the group sessions close 1001 (C11)', async () => {
    const prefix = randomPrefix();
    prefixes.push(prefix);
    const ts = await startTestServer({ redisPrefix: prefix, redisTimings: TIMINGS });
    servers.push(ts);
    const group = await createGroupWithMembers(ts, 1, { position: { page: 1 } });
    const [id] = (await inspect.keys(`${prefix}:v1:inst`)).map((key) => key.split(':').pop()!);
    const positionKey = `${prefix}:v1:p:app-a:${group.groupId}`;
    const before = await inspect.client.get(positionKey);
    await inspect.client.del(`${prefix}:v1:inst:${id!}`);
    group.leader.send({ type: 'position.update', position: { page: 2 } });
    const [leaderClosed, memberClosed] = await Promise.all([
      group.leader.closed(),
      group.members[0]!.closed(),
    ]);
    expect(leaderClosed.code).toBe(1001);
    expect(memberClosed.code).toBe(1001);
    expect(await inspect.client.get(positionKey)).toBe(before);
    expect(ts.logs.find('instance_fenced')).toBeDefined();
    // The quiet fence ran no disconnect rule: the stored group is unchanged.
    const doc = JSON.parse(
      (await inspect.client.get(`${prefix}:v1:g:app-a:${group.groupId}`))!,
    ) as { record: { leaderOnline: boolean; participantIds: string[] } };
    expect(doc.record.leaderOnline).toBe(true);
    expect(doc.record.participantIds).toHaveLength(2);
    // Under a new ID the instance serves again.
    await waitFor(async () => (await httpGet(ts.port, '/health')).status === 200);
    await waitFor(() => ts.server.storage().kind === 'redis' && isConnected(ts));
    expect((await httpGet(ts.port, '/ready')).body).toEqual({ status: 'ready', storage: 'redis' });
    expect(await ts.connectReady()).toBeDefined();
  });

  it('refuses upgrades while fenced (12.5)', async () => {
    let clock = 0;
    const prefix = randomPrefix();
    prefixes.push(prefix);
    const ts = await startTestServer({
      redisPrefix: prefix,
      redisTimings: { ...TIMINGS, heartbeatMs: 60_000 },
      monotonic: () => clock,
    });
    servers.push(ts);
    expect(ts.server.storage()).toEqual({ kind: 'redis', state: 'connected' });
    expect((await httpGet(ts.port, '/ready')).status).toBe(200);
    clock += TIMINGS.selfFenceMs;
    expect(ts.server.storage()).toEqual({ kind: 'redis', state: 'unreachable' });
    await expect(ts.connect()).rejects.toThrow();
    // Fenced: not ready (#36 AC35, Q23), still alive.
    const ready = await httpGet(ts.port, '/ready');
    expect(ready.status).toBe(503);
    expect(ready.body).toEqual({ status: 'not_ready', storage: 'redis' });
    expect((await httpGet(ts.port, '/health')).status).toBe(200);
  });
});

function isConnected(ts: TestServer): boolean {
  const status = ts.server.storage();
  return status.kind === 'redis' && status.state === 'connected';
}
