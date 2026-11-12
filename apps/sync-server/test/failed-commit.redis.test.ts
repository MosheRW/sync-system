import { afterEach, expect, it, vi } from 'vitest';
import { TokenRefresher } from '../src/groups/token-refresher.js';
import { codesOf } from './helpers/groups.js';
import { describeRedis, inspector, randomPrefix } from './helpers/redis.js';
import { type TestServer, startTestServer } from './helpers/test-server.js';

/**
 * A commit that fails with something other than "Redis unavailable" (a
 * reply error, a C7 conflict) stored nothing, so the requester's local
 * attachment is rolled back too (#35 security L1, C8): the same
 * connection can try again, and no other session is closed.
 */
describeRedis('a failed commit rolls back the local attachment (#35 security L1)', () => {
  let ts: TestServer | undefined;
  let prefix = randomPrefix();

  afterEach(async () => {
    vi.restoreAllMocks();
    await ts?.close();
    ts = undefined;
    const inspect = await inspector();
    await inspect.flush(prefix);
    inspect.close();
  });

  /** Makes every group write fail with a WRONGTYPE reply until `heal` runs. */
  async function breakWrites() {
    const inspect = await inspector();
    const live = `${prefix}:v1:live`;
    const saved = await inspect.client.zRangeWithScores(live, 0, -1);
    await inspect.client.del(live);
    await inspect.client.set(live, 'not a sorted set');
    return {
      async heal(): Promise<void> {
        await inspect.client.del(live);
        if (saved.length > 0) await inspect.client.zAdd(live, saved);
        inspect.close();
      },
    };
  }

  it('a create whose commit fails can be sent again on the same connection', async () => {
    prefix = randomPrefix();
    ts = await startTestServer({ redisPrefix: prefix });
    const reset = vi.spyOn(TokenRefresher.prototype, 'reset');
    const leader = await ts.connectReady();
    const broken = await breakWrites();
    leader.send({ type: 'group.create', reqId: 'c1', metadata: {} });
    expect(await leader.next('error')).toMatchObject({ reqId: 'c1', code: 'INTERNAL_ERROR' });
    // The create started refresh counting for a group that was never stored.
    const refresher = reset.mock.contexts[0] as TokenRefresher;
    expect(refresher.size).toBe(0);
    await broken.heal();
    leader.send({ type: 'group.create', reqId: 'c2', metadata: {} });
    expect(await leader.next()).toMatchObject({ type: 'group.created', reqId: 'c2' });
    expect(refresher.size).toBe(1);
  });

  it('a join whose commit fails can be sent again; the group is untouched', async () => {
    prefix = randomPrefix();
    ts = await startTestServer({ redisPrefix: prefix });
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {} });
    const created = await leader.next('group.created');
    const member = await ts.connectReady();
    const broken = await breakWrites();
    member.send({ type: 'group.joinByCode', reqId: 'j1', ...codesOf(created.codes) });
    expect(await member.next('error')).toMatchObject({ reqId: 'j1', code: 'INTERNAL_ERROR' });
    await broken.heal();
    // The leader was neither closed nor told about a member that never joined.
    await leader.expectNoMessage(50);
    member.send({ type: 'group.joinByCode', reqId: 'j2', ...codesOf(created.codes) });
    expect(await member.next()).toMatchObject({ type: 'group.joined', reqId: 'j2' });
    leader.send({ type: 'position.update', position: { page: 4 } });
    await leader.next('position.ack');
    expect(await member.next('position.updated')).toMatchObject({ position: { page: 4 } });
  });
});
