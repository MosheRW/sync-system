import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createLogger } from '../src/logging/logger.js';
import { LeaseLostError, StorageBusyError } from '../src/storage/errors.js';
import type { RedisLink } from '../src/storage/redis/connect.js';
import { RedisLeaseSource } from '../src/storage/redis/lease-lock.js';
import { redisContext } from '../src/storage/redis/redis-storage.js';
import { RedisWorkSource } from '../src/storage/redis/unit-of-work.js';
import { realScheduler } from '../src/time/scheduler.js';
import { createGroupWithMembers } from './helpers/groups.js';
import { describeRedis, inspector, randomPrefix, testLink } from './helpers/redis.js';
import { type TestServer, startTestServer } from './helpers/test-server.js';
import { sleep } from './helpers/wait.js';

const NS = 'app-a';
const GID = 'G'.repeat(43);
const TIMINGS = { leaseMs: 300, renewMs: 100, maxHoldMs: 700, waitMs: 250 };

describeRedis('group lease lock (#35 architecture 12.4, AC18, P2-7)', () => {
  let inspect: Awaited<ReturnType<typeof inspector>>;
  const prefixes: string[] = [];
  const links: RedisLink[] = [];
  const servers: TestServer[] = [];

  beforeAll(async () => {
    inspect = await inspector();
  });
  afterAll(() => {
    inspect.close();
  });
  afterEach(async () => {
    for (const ts of servers.splice(0)) await ts.close();
    for (const link of links.splice(0)) await link.close();
    for (const prefix of prefixes.splice(0)) await inspect.flush(prefix);
  });

  async function setup() {
    const prefix = randomPrefix();
    prefixes.push(prefix);
    const logger = createLogger({ level: 'silent' });
    const link = await testLink(prefix, logger);
    links.push(link);
    const ctx = redisContext({
      link,
      keyPrefix: prefix,
      scheduler: realScheduler(),
      logger,
      appOf: () => ({ maxSessionMinutes: 60 }) as never,
    });
    const leases = new RedisLeaseSource(ctx, TIMINGS);
    const work = new RedisWorkSource(ctx);
    work.leases = leases;
    return { prefix, leases, work, key: `${prefix}:v1:lock:${NS}:${GID}` };
  }

  it('takes the lease with a random token and a TTL, and releases only its own', async () => {
    const { leases, key } = await setup();
    const lease = await leases.acquire(NS, GID);
    expect(lease.token).toMatch(/^[0-9a-f]{32}$/);
    expect(await inspect.client.get(key)).toBe(lease.token);
    const ttl = await inspect.client.pTTL(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(TIMINGS.leaseMs);
    await lease.release();
    expect(await inspect.client.exists(key)).toBe(0);
    // A release after someone else took it deletes nothing.
    const second = await leases.acquire(NS, GID);
    await inspect.client.set(key, 'someone-else');
    await second.release();
    expect(await inspect.client.get(key)).toBe('someone-else');
  });

  it('waits up to the bound for a held lease, then fails as busy', async () => {
    const { leases, key } = await setup();
    await inspect.client.set(key, 'held-elsewhere', { PX: 5_000 });
    const started = Date.now();
    await expect(leases.acquire(NS, GID)).rejects.toBeInstanceOf(StorageBusyError);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(TIMINGS.waitMs);
    expect(waited).toBeLessThan(TIMINGS.waitMs + 500);
    // A lease freed during the wait is taken.
    await inspect.client.set(key, 'held-elsewhere', { PX: 100 });
    const lease = await leases.acquire(NS, GID);
    expect(await inspect.client.get(key)).toBe(lease.token);
    await lease.release();
  });

  it('renews while held, and stops renewing at the hold cap', async () => {
    const { leases, key } = await setup();
    const lease = await leases.acquire(NS, GID);
    await sleep(TIMINGS.leaseMs + 150);
    expect(await inspect.client.get(key)).toBe(lease.token);
    expect(lease.lost).toBe(false);
    // Past the hold cap plus one lease, it lapsed.
    await sleep(TIMINGS.maxHoldMs + TIMINGS.leaseMs);
    expect(await inspect.client.exists(key)).toBe(0);
    await lease.release();
  });

  it('marks the lease lost when another holder took it', async () => {
    const { leases, key } = await setup();
    const lease = await leases.acquire(NS, GID);
    await inspect.client.set(key, 'thief');
    await sleep(TIMINGS.renewMs * 2 + 50);
    expect(lease.lost).toBe(true);
    await lease.release();
    expect(await inspect.client.get(key)).toBe('thief');
  });

  it('a commit whose lease was taken over aborts and writes nothing (the fence)', async () => {
    const { leases, work, key, prefix } = await setup();
    const lease = await leases.acquire(NS, GID);
    const uow = work.begin(NS, GID, lease);
    uow.addStep((plan) => plan.set(`${prefix}:v1:p:${NS}:${GID}`, 'late', Date.now() + 60_000));
    await inspect.client.set(key, 'another-instance');
    await expect(uow.commit()).rejects.toBeInstanceOf(LeaseLostError);
    expect(await inspect.client.exists(`${prefix}:v1:p:${NS}:${GID}`)).toBe(0);
    await lease.release();
  });

  it('busy closes only the requester with 1001; the group stays (Q-B4, C8)', async () => {
    const prefix = randomPrefix();
    prefixes.push(prefix);
    const ts = await startTestServer({ redisPrefix: prefix, redisTimings: TIMINGS });
    servers.push(ts);
    const group = await createGroupWithMembers(ts, 1);
    // Another instance holds the group past the wait bound.
    await inspect.client.set(`${prefix}:v1:lock:app-a:${group.groupId}`, 'other', { PX: 2_000 });
    group.leader.send({ type: 'position.update', position: { page: 3 } });
    expect(await group.leader.closed()).toMatchObject({ code: 1001 });
    await group.members[0]!.expectNoMessage(100);
    expect(group.members[0]!.isClosed).toBe(false);
    expect(ts.logs.find('storage_busy_closed')).toBeDefined();
    expect(typeof ts.logs.find('group_lock_busy')?.groupRef).toBe('string');
    expect(ts.logs.text).not.toContain(group.groupId);
  });
});
