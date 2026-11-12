import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type { TokenSecrets } from '../src/config/token-secret.js';
import { lenientCodes } from '../src/storage/redis/ended.js';
import { createGroupWithMembers } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { describeRedis, inspector, randomPrefix } from './helpers/redis.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';

const APPS = [{ namespace: 'app-a', apiKey: KEY_A, joinMethods: ['A', 'C', 'D'] }];

it('reads only well-formed codes from an invalid document (#39, C17)', () => {
  expect(lenientCodes('not json')).toEqual({});
  expect(lenientCodes(undefined)).toEqual({});
  expect(lenientCodes('{"v":1,"record":null}')).toEqual({});
  expect(lenientCodes('{"record":{"codes":{"groupCode":"12345","alphaCode":"x:y"}}}')).toEqual({});
  expect(
    lenientCodes('{"record":{"codes":{"groupCode":"123456","alphaCode":"ABCDEFGH"}}}'),
  ).toEqual({ groupCode: '123456', alphaCode: 'ABCDEFGH' });
});

describeRedis('an invalid stored group frees its join codes (#39, security C17)', () => {
  let inspect: Awaited<ReturnType<typeof inspector>>;
  let prefix: string;
  let secrets: TokenSecrets;
  let scheduler: ManualScheduler;
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

  async function start(): Promise<TestServer> {
    const ts = await startTestServer({
      redisPrefix: prefix,
      tokenSecrets: secrets,
      scheduler,
      apps: APPS,
    });
    servers.push(ts);
    return ts;
  }

  async function stop(ts: TestServer): Promise<void> {
    servers.splice(servers.indexOf(ts), 1);
    await ts.server.close();
  }

  it("deletes the code keys the document names, never another group's", async () => {
    prefix = randomPrefix();
    secrets = { current: randomBytes(32), source: 'env' };
    scheduler = new ManualScheduler();
    const first = await start();
    const broken = await createGroupWithMembers(first, 0, { joinMethods: ['A', 'C'] });
    const other = await createGroupWithMembers(first, 0, { joinMethods: ['A', 'C'] });
    await stop(first);
    const base = `${prefix}:v1`;
    const own = `${base}:c:app-a:g:${broken.codes.groupCode}`;
    const foreign = `${base}:c:app-a:a:${other.codes.alphaCode}`;
    expect(await inspect.client.get(own)).toBe(broken.groupId);
    expect(await inspect.client.get(foreign)).toBe(other.groupId);
    // Invalid for the schema, but its codes are still readable: its own group
    // code, and the other group's alphanumeric code.
    await inspect.client.set(
      `${base}:g:app-a:${broken.groupId}`,
      JSON.stringify({
        v: 1,
        record: { codes: { groupCode: broken.codes.groupCode, alphaCode: other.codes.alphaCode } },
      }),
    );
    // The group had an attachment registry too (security C17).
    const registryKey = `${base}:a:app-a:${broken.groupId}`;
    expect(await inspect.client.exists(registryKey)).toBe(1);
    const second = await start();
    expect(second.logs.find('startup_sweep')).toMatchObject({ groups: 2, invalid: 1 });
    expect(await inspect.client.exists(registryKey)).toBe(0);
    expect(await inspect.client.get(own)).toBeNull();
    expect(await inspect.client.get(foreign)).toBe(other.groupId);
    expect(await inspect.client.get(`${base}:c:app-a:g:${other.codes.groupCode}`)).toBe(
      other.groupId,
    );
    // The freed group code now resolves to nothing.
    const joiner = await second.connectReady();
    joiner.send({
      type: 'group.joinByCode',
      joinCode: broken.codes.groupCode,
      doorCode: broken.codes.doorCode,
    });
    expect(await joiner.next()).toMatchObject({ type: 'error', code: 'CODE_NOT_FOUND' });
    // Neither codes nor key names show up in the logs.
    for (const secret of [broken.codes.groupCode!, other.codes.alphaCode!, prefix]) {
      expect(second.logs.text).not.toContain(secret);
    }
  });

  it('a document that is not JSON still ends; its codes expire with their TTL', async () => {
    prefix = randomPrefix();
    secrets = { current: randomBytes(32), source: 'env' };
    scheduler = new ManualScheduler();
    const first = await start();
    const broken = await createGroupWithMembers(first, 0, { joinMethods: ['A', 'C'] });
    await stop(first);
    const base = `${prefix}:v1`;
    await inspect.client.set(`${base}:g:app-a:${broken.groupId}`, 'not json');
    const second = await start();
    expect(second.logs.find('startup_sweep')).toMatchObject({ groups: 1, invalid: 1 });
    expect(await inspect.keys(`${base}:g:app-a:${broken.groupId}`)).toEqual([]);
    const ttl = await inspect.client.pTTL(`${base}:c:app-a:g:${broken.codes.groupCode}`);
    expect(ttl).toBeGreaterThan(0);
  });
});
