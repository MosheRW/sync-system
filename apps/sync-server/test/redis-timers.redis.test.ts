import { afterAll, beforeAll, expect, it } from 'vitest';
import { GroupLock } from '../src/groups/group-lock.js';
import { GroupTimers } from '../src/groups/group-timers.js';
import { createLogger } from '../src/logging/logger.js';
import type { RedisLink } from '../src/storage/redis/connect.js';
import { RedisGroupStore } from '../src/storage/redis/group-store.js';
import { redisContext } from '../src/storage/redis/redis-storage.js';
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
});
