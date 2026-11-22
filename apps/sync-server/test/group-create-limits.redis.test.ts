import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { TestClient } from './helpers/test-client.js';
import { describeRedis, inspector, randomPrefix } from './helpers/redis.js';
import { type StartOptions, type TestServer, startTestServer } from './helpers/test-server.js';

/**
 * The create limits on Redis (#12 AC2, AC3, R4, R6, L6): one budget and
 * one cap for every instance, a failed commit keeps no slot, and an ended
 * group gives its slot back in the delete's commit.
 */
describeRedis('group creation limits on Redis (#12)', () => {
  let inspect: Awaited<ReturnType<typeof inspector>>;
  let prefix: string;
  const servers: TestServer[] = [];

  beforeAll(async () => {
    inspect = await inspector();
  });
  afterAll(() => {
    inspect.close();
  });
  afterEach(async () => {
    for (const ts of servers.splice(0)) await ts.close();
    await inspect.flush(prefix);
  });

  async function start(options: StartOptions = {}): Promise<TestServer> {
    const ts = await startTestServer({ redisPrefix: prefix, ...options });
    servers.push(ts);
    return ts;
  }

  async function create(client: TestClient, reqId = 'c') {
    client.send({ type: 'group.create', reqId, metadata: {} });
    return client.next();
  }

  const live = () => inspect.client.zCard(`${prefix}:v1:lg:app-a`);

  it('counts a created group and frees its slot in the delete commit of group.end (R6)', async () => {
    prefix = randomPrefix();
    const ts = await start();
    const leader = await ts.connectReady();
    expect(await create(leader)).toMatchObject({ type: 'group.created' });
    expect(await live()).toBe(1);
    leader.send({ type: 'group.end', reqId: 'e' });
    await leader.next('group.ended');
    expect(await live()).toBe(0);
  });

  it('a create whose commit fails keeps no slot (R4)', async () => {
    prefix = randomPrefix();
    const ts = await start();
    const leader = await ts.connectReady();
    // Every group commit fails with a WRONGTYPE reply while this is set.
    const key = `${prefix}:v1:live`;
    await inspect.client.set(key, 'not a sorted set');
    expect(await create(leader, 'c1')).toMatchObject({ reqId: 'c1', code: 'INTERNAL_ERROR' });
    await expect.poll(live).toBe(0);
    await inspect.client.del(key);
    expect(await create(leader, 'c2')).toMatchObject({ type: 'group.created', reqId: 'c2' });
    expect(await live()).toBe(1);
  });

  it('two instances share one budget (AC2 across instances)', async () => {
    prefix = randomPrefix();
    const limits = { perConnection: 100, appBurst: 3, appRefillPerMinute: 1, maxLiveGroups: 100 };
    const [a, b] = [await start({ groupLimits: limits }), await start({ groupLimits: limits })];
    const replies = [];
    for (const ts of [a, b, a, b]) replies.push(await create(await ts.connectReady()));
    expect(replies.filter((r) => r.type === 'group.created')).toHaveLength(3);
    expect(replies[3]).toMatchObject({ code: 'RATE_LIMITED' });
    expect(await live()).toBe(3);
  });

  it('the cap counts the groups of every instance (AC3 across instances)', async () => {
    prefix = randomPrefix();
    const capped = { perConnection: 100, appBurst: 10, appRefillPerMinute: 1, maxLiveGroups: 21 };
    const [c, d] = [await start({ groupLimits: capped }), await start({ groupLimits: capped })];
    const far = Date.now() + 3_600_000;
    const members = Array.from({ length: 19 }, (_, i) => ({
      score: far,
      value: i.toString(36).toUpperCase().padStart(43, '0'),
    }));
    await inspect.client.zAdd(`${prefix}:v1:lg:app-a`, members);
    const [one, two] = await Promise.all([
      create(await c.connectReady()),
      create(await d.connectReady()),
    ]);
    const outcomes = [one, two].map((r) => (r.type === 'error' ? r.code : r.type)).sort();
    expect(outcomes).toEqual(['group.created', 'group.created']);
    const third = await create(await c.connectReady());
    expect(third).toMatchObject({ code: 'APP_GROUP_LIMIT', details: { maxLiveGroups: 21 } });
  });

  it('instances with different bursts share the smaller one (R13, L6)', async () => {
    prefix = randomPrefix();
    const small = await start({ env: { MAX_GROUP_CREATE_BURST_PER_APP: '2' } });
    const large = await start({ env: { MAX_GROUP_CREATE_BURST_PER_APP: '50' } });
    expect(await create(await small.connectReady())).toMatchObject({ type: 'group.created' });
    const replies = [];
    for (let i = 0; i < 3; i++) replies.push(await create(await large.connectReady()));
    expect(replies.filter((r) => r.type === 'group.created')).toHaveLength(1);
    expect(replies.slice(1)).toMatchObject([{ code: 'RATE_LIMITED' }, { code: 'RATE_LIMITED' }]);
  });
});
