import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createLogger } from '../src/logging/logger.js';
import type { CreateBudget } from '../src/groups/live-groups.js';
import { MAX_RETRY_AFTER_MS } from '../src/groups/live-groups.js';
import { StorageReplyError } from '../src/storage/errors.js';
import type { RedisLink } from '../src/storage/redis/connect.js';
import { RedisLiveGroups } from '../src/storage/redis/live-groups.js';
import { redisContext } from '../src/storage/redis/redis-storage.js';
import { RESERVE_LIVE } from '../src/storage/redis/scripts.js';
import { RedisWorkSource } from '../src/storage/redis/unit-of-work.js';
import { describeRedis, inspector, randomPrefix, testLink } from './helpers/redis.js';

const G = (letter: string) => letter.repeat(43);
const HOUR = 3_600_000;

/**
 * The Redis side of the live-group store (#12 3.1): TTLs, Redis TIME, the
 * script's own checks, and two instances sharing one budget and one cap.
 */
describeRedis('RedisLiveGroups (#12 R5, R13, R14, AC2, AC3)', () => {
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

  /** One instance on `prefix`: its own link, context and unit of work. */
  async function instance(clock: () => number = Date.now): Promise<RedisLiveGroups> {
    const link = await testLink(prefix);
    links.push(link);
    const ctx = redisContext({
      link,
      keyPrefix: prefix,
      scheduler: { now: clock, at: () => () => undefined },
      logger: createLogger({ level: 'silent' }),
      appOf: () => ({ maxSessionMinutes: 180 }) as never,
    });
    return new RedisLiveGroups(ctx, new RedisWorkSource(ctx));
  }

  const budget = (over: Partial<CreateBudget> = {}): CreateBudget => ({
    now: Date.now(),
    expiresAt: Date.now() + HOUR,
    burst: 10,
    refillPerMinute: 60,
    cap: 100,
    ...over,
  });

  const setKey = () => `${prefix}:v1:lg:app-a`;
  const bucketKey = () => `${prefix}:v1:lb:app-a`;

  it('stores the documented keys with integer TTLs, only ever extending the set (R5)', async () => {
    prefix = randomPrefix();
    const store = await instance();
    const late = Date.now() + 2 * HOUR;
    expect(await store.reserve('app-a', G('A'), budget({ expiresAt: late }))).toEqual({ ok: true });
    expect(await inspect.keys(prefix)).toEqual([bucketKey(), setKey()].sort());
    const setExpiry = await inspect.client.pExpireTime(setKey());
    expect(setExpiry).toBe(Math.ceil(late));
    // An earlier group does not shorten it.
    expect(await store.reserve('app-a', G('B'), budget())).toEqual({ ok: true });
    expect(await inspect.client.pExpireTime(setKey())).toBe(setExpiry);
    const bucketTtl = await inspect.client.pTTL(bucketKey());
    expect(Number.isSafeInteger(bucketTtl)).toBe(true);
    // max(time to full = 2 tokens at 1/s, u - now = 2 h) + 1 s.
    expect(bucketTtl).toBeGreaterThan(2 * HOUR);
    expect(bucketTtl).toBeLessThanOrEqual(2 * HOUR + 1_000);
    expect(await inspect.client.hGetAll(bucketKey())).toMatchObject({ b: '10', r: '60' });
  });

  it('clamps the bucket TTL and the wait at a tiny rate (R14, L8, L12)', async () => {
    prefix = randomPrefix();
    const store = await instance();
    // cap 3, burst 1, maxSessionMinutes 10^12.
    const tiny = { cap: 3, burst: 1, refillPerMinute: 0.5 / 1e12, expiresAt: Date.now() + 6e16 };
    expect(await store.reserve('app-a', G('A'), budget(tiny))).toEqual({ ok: true });
    const ttl = await inspect.client.pTTL(bucketKey());
    expect(Number.isSafeInteger(ttl)).toBe(true);
    expect(ttl).toBeLessThanOrEqual(MAX_RETRY_AFTER_MS);
    expect(ttl).toBeGreaterThan(MAX_RETRY_AFTER_MS - 60_000);
    const setTtl = await inspect.client.pTTL(setKey());
    expect(setTtl).toBeLessThanOrEqual(MAX_RETRY_AFTER_MS);
    expect(await store.reserve('app-a', G('B'), budget(tiny))).toEqual({
      ok: false,
      reason: 'rate',
      retryAfterMs: MAX_RETRY_AFTER_MS,
    });
  });

  it('takes now from Redis TIME, not the instance clock (R13, L7)', async () => {
    prefix = randomPrefix();
    const ahead = () => Date.now() + 1e9;
    const store = await instance(ahead);
    const one = { burst: 1, refillPerMinute: 60 };
    // Scored a minute from now (Redis time): an instance clock 11 days ahead must not prune it.
    expect(
      await store.reserve(
        'app-a',
        G('A'),
        budget({ ...one, now: ahead(), expiresAt: Date.now() + 60_000 }),
      ),
    ).toEqual({ ok: true });
    // Nor mint tokens: the bucket is empty in Redis time.
    const refused = await store.reserve('app-a', G('B'), budget({ ...one, now: ahead() }));
    expect(refused).toMatchObject({ ok: false, reason: 'rate' });
    expect((refused as { retryAfterMs: number }).retryAfterMs).toBeLessThanOrEqual(60_000);
    expect(await inspect.client.zCard(setKey())).toBe(1);
    const at = Number(await inspect.client.hGet(bucketKey(), 'a'));
    expect(at).toBeLessThan(Date.now() + 5_000);
  });

  it('refuses a bad mode or number in the script itself (R5)', async () => {
    prefix = randomPrefix();
    const link = await testLink(prefix);
    links.push(link);
    const keys = [setKey(), bucketKey()];
    const exp = String(Date.now() + HOUR);
    const bad: string[][] = [
      ['delete', G('A'), exp],
      ['', G('A'), exp],
      ['reserve', G('A'), 'x', '10', '10', '60'],
      ['reserve', G('A'), exp, 'x', '10', '60'],
      ['reserve', G('A'), exp, '-1', '10', '60'],
      ['reserve', G('A'), exp, '1.5', '10', '60'],
      ['reserve', G('A'), exp, '10', '0', '60'],
      ['reserve', G('A'), exp, '10', 'nan', '60'],
      ['reserve', G('A'), exp, '10', '10', '0'],
      ['reserve', G('A'), exp, '10', '10', '-1'],
      ['reserve', G('A'), exp, '10', '10'],
      ['register', G('A'), 'x'],
    ];
    for (const args of bad) {
      await expect(link.script(RESERVE_LIVE, keys, args), args.join(' ')).rejects.toThrow(
        StorageReplyError,
      );
    }
    expect(await inspect.keys(prefix)).toEqual([]);
    // A group ID that is not one never reaches the script.
    const store = await instance();
    await expect(store.reserve('app-a', 'a:b', budget())).rejects.toThrow('invalid redis key part');
    await expect(store.reserve('bad ns', G('A'), budget())).rejects.toThrow(
      'invalid redis key part',
    );
  });

  it('shares one budget between two instances (AC2 across instances)', async () => {
    prefix = randomPrefix();
    const [a, b] = [await instance(), await instance()];
    const three = { burst: 3, refillPerMinute: 1 };
    const results = await Promise.all(
      ['A', 'B', 'C', 'D', 'E', 'F'].map((letter, i) =>
        (i % 2 === 0 ? a : b).reserve('app-a', G(letter), budget(three)),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok && r.reason === 'rate')).toHaveLength(3);
    expect(await inspect.client.zCard(setKey())).toBe(3);
  });

  it('two instances at cap - 1 admit exactly one more (AC3 across instances)', async () => {
    prefix = randomPrefix();
    const [a, b] = [await instance(), await instance()];
    expect(await a.reserve('app-a', G('A'), budget({ cap: 3 }))).toEqual({ ok: true });
    expect(await b.reserve('app-a', G('B'), budget({ cap: 3 }))).toEqual({ ok: true });
    const results = await Promise.all([
      a.reserve('app-a', G('C'), budget({ cap: 3 })),
      b.reserve('app-a', G('D'), budget({ cap: 3 })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'cap')).toHaveLength(1);
    expect(await inspect.client.zCard(setKey())).toBe(3);
  });

  it('two instances with different bursts share the smaller one (R13, L6)', async () => {
    prefix = randomPrefix();
    const [small, large] = [await instance(), await instance()];
    expect(await small.reserve('app-a', G('A'), budget({ burst: 2, refillPerMinute: 1 }))).toEqual({
      ok: true,
    });
    const results = [];
    for (const letter of ['B', 'C', 'D']) {
      results.push(
        await large.reserve('app-a', G(letter), budget({ burst: 50, refillPerMinute: 1 })),
      );
    }
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await inspect.client.hGet(bucketKey(), 'b')).toBe('2');
  });
});
