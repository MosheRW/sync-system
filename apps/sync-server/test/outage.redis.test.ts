import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { parseRedisSettings } from '../src/config/redis.js';
import { createLogger } from '../src/logging/logger.js';
import { StorageReplyError, StorageUnavailableError } from '../src/storage/errors.js';
import { type RedisLink, connectRedis } from '../src/storage/redis/connect.js';
import { COMMIT } from '../src/storage/redis/scripts.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { LogCapture } from './helpers/log-capture.js';
import { TEST_REDIS_URL, describeRedis, inspector, randomPrefix } from './helpers/redis.js';
import { TcpProxy } from './helpers/tcp-proxy.js';
import { type TestServer, httpGet, startTestServer } from './helpers/test-server.js';
import { waitUntil } from './helpers/wait.js';

describeRedis('while Redis is unreachable (#35 AC26, AC27, ADR 0014, security C4, C8)', () => {
  let inspect: Awaited<ReturnType<typeof inspector>>;
  let proxy: TcpProxy;
  let prefix: string;
  let link: RedisLink;
  let ts: TestServer | undefined;
  let logs: LogCapture;

  beforeAll(async () => {
    inspect = await inspector();
  });
  afterAll(() => {
    inspect.close();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    proxy.restore();
    await ts?.close();
    ts = undefined;
    await proxy.close();
    await inspect.flush(prefix);
  });

  async function start(
    replayCap?: number,
    redisTimings?: { livenessMs: number; heartbeatMs: number; selfFenceMs: number },
  ): Promise<TestServer> {
    const target = new URL(TEST_REDIS_URL!);
    proxy = await TcpProxy.start(target.hostname, Number(target.port || 6379));
    const url = new URL(TEST_REDIS_URL!);
    url.hostname = '127.0.0.1';
    url.port = String(proxy.port);
    prefix = randomPrefix();
    logs = new LogCapture();
    const connected = await connectRedis(
      parseRedisSettings({
        REDIS_URL: url.toString(),
        REDIS_KEY_PREFIX: prefix,
        REDIS_COMMAND_TIMEOUT_MS: '300',
        REDIS_CONNECT_TIMEOUT_SECONDS: '1',
      })!,
      { logger: createLogger({ level: 'trace', destination: logs }), nodeEnv: 'test' },
    );
    if (!connected.ok) throw new Error(connected.message);
    link = connected.link;
    ts = await startTestServer({
      redisPrefix: prefix,
      redisLink: link,
      ...(replayCap === undefined ? {} : { replayCap }),
      ...(redisTimings === undefined ? {} : { redisTimings }),
    });
    return ts;
  }

  it('an outage longer than the self-fence closes the group sessions quietly; a new ID serves after (Q-B5)', async () => {
    const server = await start(undefined, { livenessMs: 900, heartbeatMs: 100, selfFenceMs: 600 });
    const group = await createGroupWithMembers(server, 1);
    const docKey = `${prefix}:v1:g:app-a:${group.groupId}`;
    const before = await inspect.client.get(docKey);
    const idle = await server.connectReady();
    proxy.cut();
    // Nobody sent anything: the silence alone fences the instance.
    expect(await group.leader.closed()).toMatchObject({ code: 1001 });
    expect(await group.members[0]!.closed()).toMatchObject({ code: 1001 });
    expect(server.logs.find('instance_fenced')).toMatchObject({ cause: 'silence' });
    // A session in no group stays open.
    expect(idle.isClosed).toBe(false);
    proxy.restore();
    await waitUntil(
      () => server.logs.records().filter((r) => r.event === 'instance_registered').length === 2,
      10_000,
    );
    await waitUntil(() => {
      const status = server.server.storage();
      return status.kind === 'redis' && status.state === 'connected';
    }, 10_000);
    // The fence ran no disconnect rule and queued no replay (security C13).
    expect(await inspect.client.get(docKey)).toBe(before);
    const { reply } = await resumeWith(server, group.memberTokens[0]);
    expect(reply).toMatchObject({ type: 'group.joined', groupId: group.groupId });
  });

  it('closes the group with 1001, refuses upgrades with 503, then serves again (AC26, AC27)', async () => {
    const server = await start();
    const group = await createGroupWithMembers(server, 1);
    const docKey = `${prefix}:v1:g:app-a:${group.groupId}`;
    const before = await inspect.client.get(docKey);

    proxy.cut();
    group.leader.send({ type: 'position.update', position: { page: 2 } });
    expect(await group.leader.closed()).toMatchObject({ code: 1001 });
    expect(await group.members[0]!.closed()).toMatchObject({ code: 1001 });
    await waitUntil(() => server.server.storage().kind === 'redis' && link.state === 'unreachable');
    expect(server.server.storage()).toEqual({ kind: 'redis', state: 'unreachable' });
    await expect(server.connect()).rejects.toThrow();
    expect((await httpGet(server.port, '/health')).status).toBe(200);
    // Nothing of the failed update was stored, and nothing lives in memory.
    expect(await inspect.client.get(docKey)).toBe(before);

    proxy.restore();
    await waitUntil(() => link.state === 'connected', 10_000);
    expect(server.server.storage()).toEqual({ kind: 'redis', state: 'connected' });
    // The disconnects of the closed sessions were replayed: the leader is
    // offline, the member is gone from the group.
    await waitUntil(async () => {
      const raw = await inspect.client.get(docKey);
      const doc = JSON.parse(raw!) as {
        record: { leaderOnline: boolean; participantIds: string[] };
      };
      return !doc.record.leaderOnline && doc.record.participantIds.length === 1;
    }, 10_000);
    const { reply } = await resumeWith(server, group.memberTokens[0]);
    expect(reply).toMatchObject({ type: 'group.joined', groupId: group.groupId });
    expect(logs.text).not.toContain(new URL(TEST_REDIS_URL!).password || 'unused-sentinel');
  });

  it('never falls back to memory: a create during the outage leaves no group (AC26)', async () => {
    const server = await start();
    const client = await server.connectReady();
    proxy.cut();
    client.send({ type: 'group.create', metadata: {} });
    expect(await client.closed()).toMatchObject({ code: 1001 });
    proxy.restore();
    await waitUntil(() => link.state === 'connected', 10_000);
    expect(await inspect.keys(`${prefix}:v1:g`)).toEqual([]);
  });

  it('a stalled Redis (no answers) counts as unreachable: 503 until a probe answers (C4)', async () => {
    const server = await start();
    const group = await createGroupWithMembers(server, 0);
    proxy.stall();
    group.leader.send({ type: 'position.update', position: { page: 2 } });
    expect(await group.leader.closed()).toMatchObject({ code: 1001 });
    expect(server.server.storage()).toEqual({ kind: 'redis', state: 'unreachable' });
    await expect(server.connect()).rejects.toThrow();
    proxy.restore();
    await waitUntil(() => link.state === 'connected', 10_000);
    const client = await server.connectReady();
    expect(client.isClosed).toBe(false);
  }, 20_000);

  it('a failed commit writes nothing and closes the group (AC26)', async () => {
    const server = await start();
    const group = await createGroupWithMembers(server, 1);
    const docKey = `${prefix}:v1:g:app-a:${group.groupId}`;
    const before = await inspect.client.get(docKey);
    const script = link.script.bind(link);
    vi.spyOn(link, 'script').mockImplementation((lua, keys, args) =>
      lua === COMMIT ? Promise.reject(new StorageUnavailableError()) : script(lua, keys, args),
    );
    group.leader.send({ type: 'member.remove', participantId: group.memberIds[0] });
    expect(await group.leader.closed()).toMatchObject({ code: 1001 });
    expect(await group.members[0]!.closed()).toMatchObject({ code: 1001 });
    vi.restoreAllMocks();
    expect(await inspect.client.get(docKey)).toBe(before);
  });

  it('any other Redis error is INTERNAL_ERROR to the requester only (C8)', async () => {
    const server = await start();
    const group = await createGroupWithMembers(server, 1);
    const script = link.script.bind(link);
    vi.spyOn(link, 'script').mockImplementation((lua, keys, args) =>
      lua === COMMIT ? Promise.reject(new StorageReplyError('ERR')) : script(lua, keys, args),
    );
    group.leader.send({ type: 'group.lock', reqId: 'l' });
    expect(await group.leader.next('error')).toMatchObject({ reqId: 'l', code: 'INTERNAL_ERROR' });
    vi.restoreAllMocks();
    await group.members[0]!.expectNoMessage(50);
    expect(group.members[0]!.isClosed).toBe(false);
    expect(group.leader.isClosed).toBe(false);
    expect(link.state).toBe('connected');
  });

  it('keeps a bounded replay queue and drops the oldest group (C4)', async () => {
    const server = await start(2);
    const groups: Array<Awaited<ReturnType<typeof createGroupWithMembers>>> = [];
    for (let i = 0; i < 3; i++) groups.push(await createGroupWithMembers(server, 0));
    proxy.cut();
    for (const group of groups) group.leader.terminate();
    await waitUntil(() => link.state === 'unreachable', 2000, 'unreachable');
    await new Promise((resolve) => setTimeout(resolve, 200));
    proxy.restore();
    await waitUntil(() => link.state === 'connected', 10_000, 'connected');
    const online = async (groupId: string) => {
      const raw = await inspect.client.get(`${prefix}:v1:g:app-a:${groupId}`);
      return (JSON.parse(raw!) as { record: { leaderOnline: boolean } }).record.leaderOnline;
    };
    const offline = async () => {
      let count = 0;
      for (const group of groups) if (!(await online(group.groupId))) count += 1;
      return count;
    };
    await waitUntil(async () => (await offline()) === 2, 10_000, 'replayed');
    // The oldest queued group was dropped: its stored leader stays online
    // until its next resume or the restart sweep.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await offline()).toBe(2);
  }, 20_000);
});
