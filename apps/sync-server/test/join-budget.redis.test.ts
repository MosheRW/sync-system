import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { MemoryJoinBudget } from '../src/joins/join-budget.js';
import { createLogger } from '../src/logging/logger.js';
import { StorageReplyError } from '../src/storage/errors.js';
import type { RedisLink } from '../src/storage/redis/connect.js';
import { RedisCodeIndex } from '../src/storage/redis/codes.js';
import { RedisJoinBudget } from '../src/storage/redis/join-budget.js';
import { redisContext } from '../src/storage/redis/redis-storage.js';
import { JOIN_BUDGET } from '../src/storage/redis/scripts.js';
import { describeRedis, inspector, randomPrefix, testLink } from './helpers/redis.js';
import type { TestClient } from './helpers/test-client.js';
import {
  KEY_A,
  KEY_B,
  type StartOptions,
  TestClock,
  type TestServer,
  startTestServer,
} from './helpers/test-server.js';

const WINDOW = 1000;
const MEMBER = /^[0-9a-f]{16}$/;

/**
 * The Redis side of the per-app join budget (#41 AC2, AC4, security
 * JB1-JB5): the same answers as the memory budget, keys that always
 * expire, the skew clamp, and nothing stored beyond the namespace.
 */
describeRedis('RedisJoinBudget (#41)', () => {
  const links: RedisLink[] = [];
  let inspect: Awaited<ReturnType<typeof inspector>>;
  let prefix: string;

  beforeAll(async () => {
    inspect = await inspector();
  });
  afterAll(() => {
    inspect.close();
  });
  afterEach(async () => {
    for (const link of links.splice(0)) await link.close();
    await inspect.flush(prefix);
  });

  /** One instance on `prefix` with its own clock and link. */
  async function instance(
    now: () => number,
    windowMs = WINDOW,
  ): Promise<{ budget: RedisJoinBudget; link: RedisLink }> {
    const link = await testLink(prefix);
    links.push(link);
    const ctx = redisContext({
      link,
      keyPrefix: prefix,
      scheduler: { now, at: () => () => undefined },
      logger: createLogger({ level: 'silent' }),
      appOf: () => ({ maxSessionMinutes: 180 }) as never,
    });
    return { budget: new RedisJoinBudget(ctx, windowMs), link };
  }

  const key = (ns = 'app-a') => `${prefix}:v1:lj:${ns}`;

  it('answers exactly as the memory budget for one sequence (AC2, AC4, JB3)', async () => {
    prefix = randomPrefix();
    // A realistic start so the scores are real epoch milliseconds.
    const clock = new TestClock(1_800_000_000_000);
    const { budget } = await instance(clock.now);
    const memory = new MemoryJoinBudget(clock.now, WINDOW);
    // Fill, refuse, the boundary (an attempt exactly a window old is out),
    // refusals not counted, sliding acceptance.
    const steps = [0, 100, 100, 100, 300, 400, 99, 1, 1, 0, 500, 1000, 0, 0, 0, 250, 250];
    for (const step of steps) {
      clock.advance(step);
      const [redis, local] = [
        await budget.tryAcquire('app-a', 3),
        await memory.tryAcquire('app-a', 3),
      ];
      expect(redis).toEqual(local);
      expect(await inspect.client.zCard(key())).toBeLessThanOrEqual(3);
    }
  });

  it('expires the key a window after the last accept and repairs a lost TTL (AC4, JB3)', async () => {
    prefix = randomPrefix();
    const { budget } = await instance(Date.now, 300);
    for (let i = 0; i < 2; i++) {
      expect(await budget.tryAcquire('app-a', 2)).toEqual({ ok: true });
      const ttl = await inspect.client.pTTL(key());
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300);
    }
    // A key whose TTL was removed by hand gets one again on the next refusal.
    await inspect.client.persist(key());
    expect(await inspect.client.pTTL(key())).toBe(-1);
    const refused = await budget.tryAcquire('app-a', 2);
    expect(refused.ok).toBe(false);
    const repaired = await inspect.client.pTTL(key());
    expect(repaired).toBeGreaterThan(0);
    expect(repaired).toBeLessThanOrEqual(300);
    expect(await inspect.client.zCard(key())).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await inspect.client.exists(key())).toBe(0);
  });

  it('never asks a peer behind in time to wait longer than the window (clock skew)', async () => {
    prefix = randomPrefix();
    const base = 1_800_000_000_000;
    const ahead = await instance(() => base + 5_000);
    const behind = await instance(() => base);
    expect(await ahead.budget.tryAcquire('app-a', 1)).toEqual({ ok: true });
    // The entry lies in the future for the instance behind: oldest + W - now
    // would be 6 s; the wait is clamped to the window.
    expect(await behind.budget.tryAcquire('app-a', 1)).toEqual({
      ok: false,
      retryAfterMs: WINDOW,
    });
  });

  it('two instances on one prefix share one budget', async () => {
    prefix = randomPrefix();
    const a = await instance(Date.now, 60_000);
    const b = await instance(Date.now, 60_000);
    for (let i = 0; i < 3; i++) {
      expect(await (i % 2 === 0 ? a : b).budget.tryAcquire('app-a', 3)).toEqual({ ok: true });
    }
    for (const side of [a, b]) {
      const refused = await side.budget.tryAcquire('app-a', 3);
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.retryAfterMs).toBeGreaterThan(0);
        expect(refused.retryAfterMs).toBeLessThanOrEqual(60_000);
      }
    }
    // Another app keeps its own budget.
    expect(await b.budget.tryAcquire('app-b', 3)).toEqual({ ok: true });
  });

  it('stores the namespace and random members only (JB5)', async () => {
    prefix = randomPrefix();
    const { budget } = await instance(Date.now, 60_000);
    for (let i = 0; i < 4; i++) await budget.tryAcquire('app-a', 3);
    expect(await inspect.keys(prefix)).toEqual([key()]);
    const entries = await inspect.client.zRangeWithScores(key(), 0, -1);
    expect(entries).toHaveLength(3);
    for (const { value, score } of entries) {
      expect(value).toMatch(MEMBER);
      expect(Number.isSafeInteger(score)).toBe(true);
    }
    expect(new Set(entries.map((entry) => entry.value)).size).toBe(3);
    expect(budget.size).toBe(0);
  });

  it('rejects invalid arguments in the script itself (JB2)', async () => {
    prefix = randomPrefix();
    const { link } = await instance(Date.now);
    const good = ['1800000000000', '3', '1000', 'ab'.repeat(8)];
    const bad: string[][] = [
      ['nan', '3', '1000', good[3]!],
      ['-1', '3', '1000', good[3]!],
      ['1.5', '3', '1000', good[3]!],
      [good[0]!, '0', '1000', good[3]!],
      [good[0]!, '2.5', '1000', good[3]!],
      [good[0]!, '10001', '1000', good[3]!],
      [good[0]!, '3', '0', good[3]!],
      [good[0]!, '3', '3600001', good[3]!],
      [good[0]!, '3', '1000', 'AB'.repeat(8)],
      [good[0]!, '3', '1000', 'ab'.repeat(9)],
      [good[0]!, '3', '1000', 'ab:cdefabcdefabc'],
    ];
    for (const args of bad) {
      await expect(link.script(JOIN_BUDGET, [key()], args)).rejects.toBeInstanceOf(
        StorageReplyError,
      );
    }
    expect(await inspect.keys(prefix)).toEqual([]);
    expect(await link.script(JOIN_BUDGET, [key()], good)).toEqual(['ok']);
  });

  it('rejects a limit over the cap before calling Redis (security S6)', async () => {
    prefix = randomPrefix();
    const { budget } = await instance(Date.now);
    await expect(budget.tryAcquire('app-a', 10_001)).rejects.toThrow(RangeError);
    expect(await inspect.keys(prefix)).toEqual([]);
  });
});

/**
 * Two servers on one prefix (#41 AC1, AC2, AC3): the 600 attempts per app
 * per minute are spent once over both, whichever instance gets them, for
 * group.joinByCode and group.joinByQr alike.
 */
describeRedis('the per-app join budget across instances (#41)', () => {
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
    const ts = await startTestServer({
      redisPrefix: prefix,
      apps: [
        { namespace: 'app-a', apiKey: KEY_A, maxConnections: 1000 },
        { namespace: 'app-b', apiKey: KEY_B },
      ],
      env: { MAX_CONNECTIONS: '2000', MAX_APP_CONNECTIONS_CEILING: '1000' },
      ...options,
    });
    servers.push(ts);
    return ts;
  }

  /** `count` connections on `ts`, each sending 10 attempts with an unknown code. */
  async function spend(ts: TestServer, count: number): Promise<TestClient[]> {
    const clients: TestClient[] = [];
    for (let c = 0; c < count; c++) {
      const client = await ts.connectReady();
      clients.push(client);
      for (let i = 0; i < 10; i++) client.send({ type: 'group.joinByCode', joinCode: '000000' });
    }
    return clients;
  }

  it('600 attempts over two instances, then both refuse before any lookup (AC1-AC3)', async () => {
    prefix = randomPrefix();
    const [a, b] = [await start(), await start()];
    const lookup = vi.spyOn(RedisCodeIndex.prototype, 'lookup');
    const clients = [...(await spend(a, 35)), ...(await spend(b, 25))];
    for (const client of clients) {
      for (let i = 0; i < 10; i++) {
        expect(await client.next('error')).toMatchObject({ code: 'CODE_NOT_FOUND' });
      }
    }
    expect(lookup).toHaveBeenCalledTimes(600);
    expect(await inspect.client.zCard(`${prefix}:v1:lj:app-a`)).toBe(600);

    for (const ts of [a, b]) {
      const extra = await ts.connectReady();
      extra.send({ type: 'group.joinByCode', reqId: 'x', joinCode: '000000' });
      const refused = await extra.next('error');
      expect(refused).toMatchObject({
        reqId: 'x',
        code: 'RATE_LIMITED',
        message: 'Too many join attempts',
      });
      const wait = Number(refused.details?.retryAfterMs);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(60_000);
      expect(
        ts.logs.records().filter((record) => record.event === 'join_app_budget_exhausted'),
      ).toEqual([expect.objectContaining({ namespace: 'app-a' })]);
    }
    // Both actions share the budget: a QR attempt is refused before the ticket check.
    const qr = await b.connectReady();
    qr.send({ type: 'group.joinByQr', reqId: 'q', ticket: 'not-a-ticket' });
    expect(await qr.next('error')).toMatchObject({ reqId: 'q', code: 'RATE_LIMITED' });
    expect(lookup).toHaveBeenCalledTimes(600);
    expect(await inspect.client.zCard(`${prefix}:v1:lj:app-a`)).toBe(600);

    // Another app keeps its own budget.
    const other = await b.connectReady(KEY_B);
    other.send({ type: 'group.joinByCode', reqId: 'o', joinCode: '000000' });
    expect(await other.next('error')).toMatchObject({ reqId: 'o', code: 'CODE_NOT_FOUND' });
  });
});
