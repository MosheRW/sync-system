import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { GroupLock } from '../src/groups/group-lock.js';
import { GroupTimers } from '../src/groups/group-timers.js';
import { createLogger } from '../src/logging/logger.js';
import type { RedisLink } from '../src/storage/redis/connect.js';
import { RedisGroupStore } from '../src/storage/redis/group-store.js';
import { redisContext } from '../src/storage/redis/redis-storage.js';
import { CLAIM_DUE } from '../src/storage/redis/scripts.js';
import { RedisTimerBackend } from '../src/storage/redis/timers.js';
import { RedisWorkSource } from '../src/storage/redis/unit-of-work.js';
import { record } from './contracts/group-store.js';
import { timerBackendContract } from './contracts/timers.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { describeRedis, inspector, randomPrefix, testLink } from './helpers/redis.js';

const G = 'T'.repeat(43);
const NOW = 1_767_225_600_000;

describeRedis('Redis timers (#35 AC7, AC12, ADR 0013, F13)', () => {
  let link: RedisLink;
  let inspect: Awaited<ReturnType<typeof inspector>>;
  let prefix = randomPrefix();
  beforeAll(async () => {
    link = await testLink(prefix);
    inspect = await inspector();
  });
  afterAll(async () => {
    inspect.close();
    await link.close();
  });

  async function setup() {
    prefix = randomPrefix();
    const scheduler = new ManualScheduler(NOW);
    const ctx = redisContext({
      link,
      keyPrefix: prefix,
      scheduler,
      logger: createLogger({ level: 'silent' }),
      appOf: () => ({ maxSessionMinutes: 60 }) as never,
    });
    const work = new RedisWorkSource(ctx);
    const store = new RedisGroupStore(ctx, work);
    await store.create(record({ id: G, createdAt: NOW }));
    const backend = new RedisTimerBackend(ctx, work, scheduler);
    const timers = new GroupTimers(backend);
    const lock = new GroupLock(work);
    const pending = new Set<Promise<unknown>>();
    const inTask = (step: () => void | Promise<void>): Promise<void> => {
      const run = lock.run('app-a', G, async () => {
        await store.get('app-a', G);
        await step();
      });
      pending.add(run);
      void run.finally(() => pending.delete(run));
      return run;
    };
    const settle = async () => {
      await backend.runDue();
      while (pending.size > 0) await Promise.all([...pending]);
    };
    return { scheduler, store, backend, timers, inTask, settle };
  }

  timerBackendContract('redis', {
    make: async () => {
      const { scheduler, timers, inTask, settle } = await setup();
      return {
        timers,
        inTask,
        advance: async (ms: number) => {
          scheduler.advance(ms);
          await settle();
        },
        now: () => scheduler.now(),
      };
    },
    cleanup: () => inspect.flush(prefix),
  });

  it('fires deadlines that passed while nothing ran, once (AC12)', async () => {
    const { scheduler, timers, inTask, backend, settle } = await setup();
    const fired: string[] = [];
    timers.on('frozenEnd', (_ns, _id, _data, claim) => {
      void inTask(() => {
        claim?.();
        fired.push('frozenEnd');
      });
    });
    await inTask(() => timers.arm('app-a', G, 'frozenEnd', NOW + 1000));
    backend.stop();
    // The server is "down": time passes with no wake-up.
    scheduler.time = NOW + 60_000;
    await settle();
    expect(fired).toEqual(['frozenEnd']);
    await settle();
    expect(fired).toEqual(['frozenEnd']);
    expect(await inspect.client.zCard(`${prefix}:v1:due`)).toBe(0);
    await inspect.flush(prefix);
  });

  it('runs a timer again after its lease when the handler failed', async () => {
    const { scheduler, timers, inTask, settle } = await setup();
    let calls = 0;
    timers.on('grace', (_ns, _id, _data, claim) => {
      calls += 1;
      if (calls === 1) return; // the handler never committed (crash)
      void inTask(() => claim?.());
    });
    await inTask(() => timers.arm('app-a', G, 'grace', NOW + 10, { term: 1, at: NOW + 10 }));
    scheduler.advance(10);
    await settle();
    expect(calls).toBe(1);
    scheduler.time += 29_000;
    await settle();
    expect(calls).toBe(1);
    scheduler.time += 2_000;
    await settle();
    expect(calls).toBe(2);
    expect(await inspect.client.zCard(`${prefix}:v1:due`)).toBe(0);
    await inspect.flush(prefix);
  });

  it('drops invalid timer data and keeps the group (C1)', async () => {
    const { scheduler, timers, inTask, store, settle } = await setup();
    const fired: string[] = [];
    timers.on('frozenEnd', () => fired.push('frozenEnd'));
    await inTask(() => timers.arm('app-a', G, 'frozenEnd', NOW + 10));
    await inspect.client.hSet(`${prefix}:v1:t:app-a:${G}`, 'frozenEnd', '{"at":"NaN"}');
    scheduler.advance(10);
    await settle();
    expect(fired).toEqual([]);
    expect(await inspect.client.zCard(`${prefix}:v1:due`)).toBe(0);
    expect(await store.get('app-a', G)).toBeDefined();
    await inspect.flush(prefix);
  });

  it('prunes due members of gone groups and live members past their end (F13)', async () => {
    const { scheduler, timers, inTask, settle } = await setup();
    await inTask(() => timers.arm('app-a', G, 'maxSession', NOW + 10));
    // The group's keys expired while the server was down.
    await inspect.client.del([`${prefix}:v1:t:app-a:${G}`, `${prefix}:v1:g:app-a:${G}`]);
    scheduler.time = NOW + 2 * 60 * 60_000;
    await settle();
    expect(await inspect.client.zCard(`${prefix}:v1:due`)).toBe(0);
    expect(await inspect.client.zCard(`${prefix}:v1:live`)).toBe(0);
    await inspect.flush(prefix);
  });

  it('keeps the timer hash and the due set no longer than the group (AC24)', async () => {
    const { timers, inTask } = await setup();
    await inTask(() => timers.arm('app-a', G, 'maxSession', NOW + 60 * 60_000));
    for (const key of [`${prefix}:v1:t:app-a:${G}`, `${prefix}:v1:due`]) {
      const ttl = await inspect.client.pTTL(key);
      expect(ttl, key).toBeGreaterThan(0);
      expect(ttl, key).toBeLessThanOrEqual(60 * 60_000 + 5000);
    }
    await inspect.flush(prefix);
  });
  /** `n` group IDs, distinct and of a group ID's length. */
  const ids = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => String(from + i).padStart(43, '0'));

  /** Seeds expired members of app-a in `live` and `lg:app-a` (end bound before NOW). */
  async function seedExpired(groupIds: string[]): Promise<void> {
    for (const [i, id] of groupIds.entries()) {
      await inspect.client.zAdd(`${prefix}:v1:live`, {
        score: NOW - 1000 - i,
        value: `app-a:${id}`,
      });
      await inspect.client.zAdd(`${prefix}:v1:lg:app-a`, { score: NOW - 1000 - i, value: id });
    }
  }

  it('frees expired live members in bounded batches, whatever their shape (#47 AC2)', async () => {
    prefix = randomPrefix();
    const live = `${prefix}:v1:live`;
    const lg = `${prefix}:v1:lg:app-a`;
    const expired = ids(5);
    await seedExpired(expired);
    // A member without ':' (removed from live only) and one still live.
    await inspect.client.zAdd(live, { score: NOW - 10, value: 'malformed' });
    const [kept] = ids(1, 100);
    await inspect.client.zAdd(live, { score: NOW + 60_000, value: `app-a:${kept}` });
    await inspect.client.zAdd(lg, { score: NOW + 60_000, value: kept! });
    const claim = () =>
      link.script(
        CLAIM_DUE,
        [`${prefix}:v1:due`, live],
        [`${prefix}:v1:t:`, String(NOW), String(NOW + 30_000), '2', `${prefix}:v1:lg:`],
      );
    const freed: number[] = [];
    for (;;) {
      const before = await inspect.client.zCard(live);
      const reply = (await claim()) as unknown[];
      expect(reply).toHaveLength(1);
      const count = Number(reply[0]);
      expect(count).toBeLessThanOrEqual(2);
      expect(await inspect.client.zCard(live)).toBe(before - count);
      freed.push(count);
      if (count === 0) break;
    }
    expect(freed).toEqual([2, 2, 2, 0]);
    expect(await inspect.client.zRange(live, 0, -1)).toEqual([`app-a:${kept}`]);
    expect(await inspect.client.zRange(lg, 0, -1)).toEqual([kept]);
    await inspect.flush(prefix);
  });

  for (const [count, calls] of [
    [2 * 64 + 1, 3],
    [64, 2],
  ] as const) {
    it(`frees a backlog of ${count} expired live members in one runDue (#47 AC2)`, async () => {
      const { backend } = await setup();
      const live = `${prefix}:v1:live`;
      const lg = `${prefix}:v1:lg:app-a`;
      const liveBefore = await inspect.client.zRange(live, 0, -1);
      const lgBefore = await inspect.client.zRange(lg, 0, -1);
      await seedExpired(ids(count));
      const script = vi.spyOn(link, 'script');
      try {
        await backend.runDue();
        // One call per full batch, then one that frees less than a batch.
        expect(script.mock.calls.filter(([s]) => s === CLAIM_DUE)).toHaveLength(calls);
      } finally {
        script.mockRestore();
      }
      expect(await inspect.client.zRange(live, 0, -1)).toEqual(liveBefore);
      expect(await inspect.client.zRange(lg, 0, -1)).toEqual(lgBefore);
      await inspect.flush(prefix);
    });
  }
});
