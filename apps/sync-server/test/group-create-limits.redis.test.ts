import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { GroupService } from '../src/groups/group-service.js';
import { LeaderControls } from '../src/lifecycle/leader-controls.js';
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
    vi.restoreAllMocks();
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

  // #48: forgetGroup also runs for the cluster `forget` op, so neither may
  // free the slot; only endGroup does, in the delete's commit (R6). The
  // service is reached through the class prototype (no test-only export).
  type Forgetter = {
    forgetGroup(ns: string, gid: string, record: undefined): Promise<void>;
    lock: { run<T>(ns: string, gid: string, task: () => Promise<T>): Promise<T> };
    receiveRemote(effects: { op: 'forget'; ns: string; gid: string }[]): void;
  };

  async function createOne() {
    const created = vi.spyOn(GroupService.prototype, 'create');
    const ts = await start();
    const leader = await ts.connectReady();
    const reply = await create(leader);
    expect(reply).toMatchObject({ type: 'group.created' });
    const service = created.mock.contexts[0] as unknown as Forgetter;
    return { leader, service, groupId: (reply as { groupId: string }).groupId };
  }

  async function end(leader: TestClient) {
    leader.send({ type: 'group.end', reqId: 'e' });
    await leader.next('group.ended');
  }

  it('forgetGroup keeps the slot; group.end then frees it (#48)', async () => {
    prefix = randomPrefix();
    const { leader, service, groupId } = await createOne();
    expect(await live()).toBe(1);
    // On Redis the cleanup needs a group task, as endGroup has.
    await service.lock.run('app-a', groupId, () =>
      service.forgetGroup('app-a', groupId, undefined),
    );
    expect(await live()).toBe(1);
    await end(leader);
    expect(await live()).toBe(0);
  });

  it('a cluster forget from another instance keeps the slot; group.end then frees it (#48)', async () => {
    prefix = randomPrefix();
    const forgotten = vi.spyOn(LeaderControls.prototype, 'forgetGroup');
    const { leader, service, groupId } = await createOne();
    expect(await live()).toBe(1);
    service.receiveRemote([{ op: 'forget', ns: 'app-a', gid: groupId }]);
    await vi.waitFor(() => expect(forgotten).toHaveBeenCalledWith('app-a', groupId));
    expect(await live()).toBe(1);
    await end(leader);
    expect(await live()).toBe(0);
  });
});
