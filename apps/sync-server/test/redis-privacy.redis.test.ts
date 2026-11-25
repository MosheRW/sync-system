import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { parseRedisSettings } from '../src/config/redis.js';
import type { TokenSecrets } from '../src/config/token-secret.js';
import { endedRef } from '../src/groups/ended-groups.js';
import { createLogger } from '../src/logging/logger.js';
import { connectRedis } from '../src/storage/redis/connect.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { LogCapture } from './helpers/log-capture.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { TEST_REDIS_URL, describeRedis, inspector, randomPrefix } from './helpers/redis.js';
import { TcpProxy } from './helpers/tcp-proxy.js';
import { KEY_A, type TestServer, startTestServer } from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

const MINUTE = 60_000;
const NAME = 'SentinelDisplayName';
const POSITION = 'SENTINEL-POSITION-77';

describeRedis('Redis keys, values and logs (#35 AC5, AC8, AC24, AC25, F13)', () => {
  let inspect: Awaited<ReturnType<typeof inspector>>;
  const prefixes: string[] = [];
  const servers: TestServer[] = [];

  beforeAll(async () => {
    inspect = await inspector();
  });
  afterAll(() => {
    inspect.close();
  });
  afterEach(async () => {
    for (const ts of servers.splice(0)) await ts.close();
    for (const prefix of prefixes.splice(0)) await inspect.flush(prefix);
  });

  async function start(
    prefix: string,
    extra: { scheduler?: ManualScheduler; tokenSecrets?: TokenSecrets } = {},
  ): Promise<TestServer> {
    prefixes.push(prefix);
    const ts = await startTestServer({ redisPrefix: prefix, ...extra });
    servers.push(ts);
    return ts;
  }

  /** Every key under `prefix` with its whole value as text. */
  async function dump(prefix: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const key of await inspect.keys(prefix)) {
      const type = await inspect.client.type(key);
      if (type === 'string') out.set(key, (await inspect.client.get(key)) ?? '');
      else if (type === 'hash') out.set(key, JSON.stringify(await inspect.client.hGetAll(key)));
      else if (type === 'zset') {
        out.set(key, JSON.stringify(await inspect.client.zRangeWithScores(key, 0, -1)));
      } else out.set(key, `<${type}>`);
    }
    return out;
  }

  it('keeps two prefixes apart on one Redis (AC5)', async () => {
    const a = await start(randomPrefix());
    const b = await start(randomPrefix());
    const group = await createGroupWithMembers(a, 0);
    const joiner = await b.connectReady();
    joiner.send({ type: 'group.joinByCode', ...group.join });
    expect(await joiner.next('error')).toMatchObject({ code: 'CODE_NOT_FOUND' });
    const { reply } = await resumeWith(b, group.leaderToken, { metadata: {} });
    // B never saw the group: for B it is a group to recover, not A's group.
    expect(reply).not.toMatchObject({ type: 'group.resumed', recreated: false });
    for (const key of await inspect.keys(prefixes[1]!))
      expect(key.startsWith(`${prefixes[1]}:`)).toBe(true);
    for (const key of await inspect.keys(prefixes[0]!)) expect(key).not.toContain(prefixes[1]);
    expect((await inspect.keys(prefixes[0]!)).some((key) => key.includes(group.groupId))).toBe(
      true,
    );
  });

  it('stores no token, secret, ticket, blob or API key (AC8)', async () => {
    const secret = randomBytes(32);
    const ts = await start(randomPrefix(), { tokenSecrets: { current: secret, source: 'env' } });
    const group = await createGroupWithMembers(ts, 1, { joinMethods: ['A', 'D'] });
    group.leader.send({ type: 'qr.issue' });
    const ticket = (await group.leader.next('qr.ticket')).ticket;
    const qr = await ts.connectReady();
    qr.send({ type: 'group.joinByQr', ticket, displayName: NAME });
    const joined = await qr.next('group.joined');
    group.leader.send({ type: 'position.update', position: { p: POSITION } });
    await group.leader.next('position.ack');
    const { reply } = await resumeWith(ts, group.memberTokens[0]);
    const values = [...(await dump(prefixes[0]!)).entries()]
      .map(([k, v]) => `${k} ${v}`)
      .join('\n');
    const forbidden = [
      group.leaderToken,
      ...group.memberTokens,
      joined.token,
      (reply as { token: string }).token,
      ticket,
      group.codes.blob,
      KEY_A,
      secret.toString('base64'),
      secret.toString('hex'),
      secret.toString('base64url'),
    ];
    for (const value of forbidden) {
      // Tokens and tickets are JWT-like: no segment of them is stored either.
      for (const part of value.split('.').filter((p) => p.length >= 16)) {
        expect(values).not.toContain(part);
      }
    }
    // What is stored is the group itself (names live in the document only).
    expect(values).toContain(NAME);
    expect(values).toContain(POSITION);
  });

  it('bounds every key of a group by E and leaves only the ended entry after the end (AC24)', async () => {
    const scheduler = new ManualScheduler();
    const ts = await start(randomPrefix(), { scheduler });
    const prefix = prefixes[0]!;
    const group = await createGroupWithMembers(ts, 1, { joinMethods: ['A'] });
    // A door failure and a pause, so door state and timers are stored too.
    const guesser = await ts.connectReady();
    guesser.send({ type: 'group.joinByCode', joinCode: group.join.joinCode, doorCode: '000001' });
    await guesser.next('error');
    group.leader.terminate();
    await group.members[0]!.next('leader.offline');
    const end = 180 * MINUTE + 5000;
    for (const key of await inspect.keys(prefix)) {
      const ttl = await inspect.client.pTTL(key);
      expect(ttl, key).toBeGreaterThan(0);
      // Instance metadata holds no group data (#35 architecture 12.3): the
      // liveness key lives 15 s, the instance list 24 h after a registration.
      if (key.endsWith(':insts')) expect(ttl, key).toBeLessThanOrEqual(24 * 60 * MINUTE);
      else if (key.includes(':inst:')) expect(ttl, key).toBeLessThanOrEqual(15_000);
      else expect(ttl, key).toBeLessThanOrEqual(key.endsWith(':epoch') ? end + 5 * MINUTE : end);
    }
    // The create budget `lb:<ns>` is the one key bounded at E + 1 ms (#47):
    // it ends 1 ms after the app's latest group, so its PTTL above is within
    // E only because time has passed since the create. Its absolute expiry
    // is at most 1 ms after the app's live set's.
    const budgetEnd = await inspect.client.pExpireTime(`${prefix}:v1:lb:app-a`);
    expect(budgetEnd).toBeGreaterThan(0);
    expect(budgetEnd).toBeLessThanOrEqual(
      (await inspect.client.pExpireTime(`${prefix}:v1:lg:app-a`)) + 1,
    );
    const leader = (await resumeWith(ts, group.leaderToken)).client;
    leader.send({ type: 'group.end' });
    await leader.next('group.ended');
    const keys = await inspect.keys(prefix);
    expect(keys.filter((key) => key.includes(group.groupId))).toEqual([]);
    expect(keys.filter((key) => key.includes(':c:'))).toEqual([]);
    const dumped = [...(await dump(prefix)).values()].join('\n');
    expect(dumped).not.toContain(group.groupId);
    const ref = endedRef('app-a', group.groupId);
    const ttl = await inspect.client.pTTL(`${prefix}:v1:e:${ref}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(180 * MINUTE);
  });

  it('prunes a group that expired while the server was down (AC24, F13)', async () => {
    const scheduler = new ManualScheduler();
    const tokenSecrets: TokenSecrets = { current: randomBytes(32), source: 'env' };
    const prefix = randomPrefix();
    const first = await start(prefix, { scheduler, tokenSecrets });
    const group = await createGroupWithMembers(first, 1);
    servers.splice(servers.indexOf(first), 1);
    await first.server.close();
    // Redis dropped the group's own keys at E (TTL); the shared sets keep
    // its members until a poll or the restart prunes them.
    for (const [key, value] of await dump(prefix)) {
      // The group's document, position, timers and code keys (TTL <= E).
      if (key.includes(group.groupId) || value === group.groupId) await inspect.client.del(key);
    }
    scheduler.advance(181 * MINUTE);
    await start(prefix, { scheduler, tokenSecrets });
    const dumped = [...(await dump(prefix)).values()].join('\n');
    expect(dumped).not.toContain(group.groupId);
  });

  it('logs no URL, host, password, key, code, name, ID or position through an outage (AC25)', async () => {
    const target = new URL(TEST_REDIS_URL!);
    const proxy = await TcpProxy.start(target.hostname, Number(target.port || 6379));
    const url = new URL(TEST_REDIS_URL!);
    url.hostname = '127.0.0.1';
    url.port = String(proxy.port);
    const prefix = randomPrefix();
    const redisLogs = new LogCapture();
    const connected = await connectRedis(
      parseRedisSettings({
        REDIS_URL: url.toString(),
        REDIS_KEY_PREFIX: prefix,
        REDIS_COMMAND_TIMEOUT_MS: '300',
        REDIS_CONNECT_TIMEOUT_SECONDS: '1',
      })!,
      { logger: createLogger({ level: 'trace', destination: redisLogs }), nodeEnv: 'test' },
    );
    if (!connected.ok) throw new Error(connected.message);
    prefixes.push(prefix);
    const ts = await startTestServer({ redisPrefix: prefix, redisLink: connected.link });
    servers.push(ts);
    const leader = await ts.connectReady();
    leader.send({ type: 'group.create', metadata: {}, displayName: NAME });
    const created = await leader.next('group.created');
    const member = await ts.connectReady();
    member.send({
      type: 'group.joinByCode',
      joinCode: created.codes.groupCode,
      doorCode: created.codes.doorCode,
      displayName: NAME,
    });
    const joined = await member.next('group.joined');
    leader.send({ type: 'position.update', position: { p: POSITION } });
    await leader.next('position.ack');
    proxy.cut();
    leader.send({ type: 'position.update', position: { p: POSITION } });
    await leader.closed();
    await member.closed();
    proxy.restore();
    await waitUntil(() => connected.link.state === 'connected', 10_000);
    await waitUntil(() => ts.logs.text.includes('group_held'), 10_000);
    await proxy.close();
    const text = `${ts.logs.text}\n${redisLogs.text}`;
    expect(text).toContain('redis_unreachable');
    const forbidden = [
      target.host,
      `:${proxy.port}`,
      `${prefix}:v1`,
      created.groupId,
      created.participantId,
      joined.participantId,
      created.codes.groupCode!,
      created.codes.doorCode!,
      NAME,
      POSITION,
    ];
    if (target.password !== '') forbidden.push(target.password);
    for (const value of forbidden) expect(text).not.toContain(value);
  }, 30_000);
});
