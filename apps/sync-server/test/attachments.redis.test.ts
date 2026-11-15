import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { describeRedis, inspector, randomPrefix } from './helpers/redis.js';
import { type TestServer, startTestServer } from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

const MINUTE = 60_000;

interface Registry {
  v: number;
  a: Record<string, { i: string; t: string }>;
}

describeRedis('attachment registry in Redis (#35 architecture 12.6, AC24)', () => {
  let inspect: Awaited<ReturnType<typeof inspector>>;
  let prefix: string;
  let ts: TestServer | undefined;

  beforeAll(async () => {
    inspect = await inspector();
  });
  afterAll(() => {
    inspect.close();
  });
  afterEach(async () => {
    await ts?.close();
    ts = undefined;
    await inspect.flush(prefix);
  });

  async function start(): Promise<TestServer> {
    prefix = randomPrefix();
    ts = await startTestServer({ redisPrefix: prefix });
    return ts;
  }

  async function registry(groupId: string): Promise<Registry | null> {
    const raw = await inspect.client.get(`${prefix}:v1:a:app-a:${groupId}`);
    return raw === null ? null : (JSON.parse(raw) as Registry);
  }

  async function instanceId(): Promise<string> {
    const [key] = await inspect.keys(`${prefix}:v1:inst`);
    return key!.split(':').pop()!;
  }

  it('names every connected participant with this instance and an attach ID, bounded by E', async () => {
    const server = await start();
    const group = await createGroupWithMembers(server, 2);
    const id = await instanceId();
    const stored = await registry(group.groupId);
    expect(stored?.v).toBe(1);
    expect(Object.keys(stored!.a).sort()).toEqual([group.leaderId, ...group.memberIds].sort());
    for (const entry of Object.values(stored!.a)) {
      expect(entry.i).toBe(id);
      expect(entry.t).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
    const ttl = await inspect.client.pTTL(`${prefix}:v1:a:app-a:${group.groupId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(180 * MINUTE + 5000);
    const groupsKey = `${prefix}:v1:ig:${id}`;
    expect(await inspect.client.sMembers(groupsKey)).toEqual([`app-a:${group.groupId}`]);
    expect(await inspect.client.pTTL(groupsKey)).toBeLessThanOrEqual(180 * MINUTE + 5000);
    // Nothing a client sees carries the attach ID or the instance ID.
    expect(server.logs.text).not.toContain(id);
    for (const entry of Object.values(stored!.a)) expect(server.logs.text).not.toContain(entry.t);
  });

  it('follows leaves, disconnects, a resume (new attach ID) and the end (AC24)', async () => {
    const server = await start();
    const group = await createGroupWithMembers(server, 2);
    const id = await instanceId();
    const before = (await registry(group.groupId))!;
    group.members[0]!.send({ type: 'group.leave' });
    await group.members[0]!.next('group.left');
    expect(Object.keys((await registry(group.groupId))!.a)).not.toContain(group.memberIds[0]);
    // A resume replaces the attachment: a new attach ID.
    const { client } = await resumeWith(server, group.memberTokens[1]);
    const resumed = (await registry(group.groupId))!;
    expect(resumed.a[group.memberIds[1]!]!.t).not.toBe(before.a[group.memberIds[1]!]!.t);
    // The leader goes offline: its entry goes.
    group.leader.terminate();
    await client.next('leader.offline');
    await waitUntil(async () => !((await registry(group.groupId))?.a[group.leaderId] ?? false));
    const { client: leader } = await resumeWith(server, group.leaderToken);
    expect((await registry(group.groupId))!.a[group.leaderId]?.i).toBe(id);
    leader.send({ type: 'group.end' });
    await leader.next('group.ended');
    expect(await registry(group.groupId)).toBeNull();
    expect(
      await inspect.client.sIsMember(`${prefix}:v1:ig:${id}`, `app-a:${group.groupId}`),
    ).toBeFalsy();
  });

  it('an invalid stored registry fails closed: nobody acts on the group (C1)', async () => {
    const server = await start();
    const group = await createGroupWithMembers(server, 1);
    await inspect.client.set(
      `${prefix}:v1:a:app-a:${group.groupId}`,
      `{"v":1,"a":{"__proto__":{"i":"${'ab'.repeat(16)}","t":"${'A'.repeat(22)}"}}}`,
    );
    const docKey = `${prefix}:v1:g:app-a:${group.groupId}`;
    const before = await inspect.client.get(docKey);
    group.leader.send({ type: 'position.update', position: { page: 2 } });
    expect(await group.leader.next('error')).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(await inspect.client.get(docKey)).toBe(before);
    expect(server.logs.find('store_document_invalid')).toBeDefined();
    expect(server.logs.text).not.toContain('__proto__');
  });
});
