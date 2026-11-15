import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { type TestCluster, startCluster } from './helpers/cluster.js';
import { codesOf } from './helpers/groups.js';
import { describeRedis, inspector } from './helpers/redis.js';
import { sleep } from './helpers/wait.js';

/** Instance metadata that must survive a loss of the group data. */
const KEEP = [':inst:', ':insts', ':ig:', ':seq', ':lock:'];

describeRedis('parked members across instances (#35 architecture 12.10, AC14)', () => {
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

  it('a member parked on B is admitted when the leader recreates the group on A', async () => {
    cluster = await startCluster();
    const [a, b] = cluster.nodes;
    const leader = await a!.ts.connectReady();
    leader.send({ type: 'group.create', metadata: { contentId: 'c' } });
    const created = await leader.next('group.created');
    const member = await a!.ts.connectReady();
    member.send({ type: 'group.joinByCode', ...codesOf(created.codes) });
    const joined = await member.next('group.joined');
    leader.terminate();
    member.terminate();
    // Tokens older than the next epoch, then Redis loses the groups (AC14).
    await sleep(1_100);
    for (const key of await inspect.keys(cluster.prefix)) {
      if (!KEEP.some((part) => key.includes(part))) await inspect.client.del(key);
    }
    const parked = await b!.ts.connectReady();
    parked.send({ type: 'group.resume', token: joined.token });
    expect(await parked.next('group.waiting')).toMatchObject({ groupId: created.groupId });
    const pk = `${cluster.prefix}:v1:pk:app-a:${created.groupId}`;
    expect(await inspect.client.sCard(pk)).toBe(1);
    expect(await inspect.client.pTTL(pk)).toBeGreaterThan(0);
    const back = await a!.ts.connectReady();
    back.send({ type: 'group.resume', token: created.token, metadata: { contentId: 'c' } });
    expect(await back.next('group.resumed')).toMatchObject({ recreated: true });
    expect(await parked.next('group.joined', 5_000)).toMatchObject({
      groupId: created.groupId,
      participantId: joined.participantId,
    });
    expect(await inspect.client.exists(pk)).toBe(0);
    // A real member again: moves from A reach it on B.
    back.send({ type: 'position.update', position: { page: 3 } });
    await back.next('position.ack');
    expect(await parked.next('position.updated')).toMatchObject({ position: { page: 3 } });
  });
});
