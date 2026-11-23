import { afterAll, beforeAll } from 'vitest';
import { createLogger } from '../src/logging/logger.js';
import type { RedisLink } from '../src/storage/redis/connect.js';
import { RedisCodeIndex } from '../src/storage/redis/codes.js';
import { RedisDoorStates } from '../src/storage/redis/doors.js';
import { RedisEndedGroups } from '../src/storage/redis/ended.js';
import { RedisGroupStore } from '../src/storage/redis/group-store.js';
import { redisContext } from '../src/storage/redis/redis-storage.js';
import { RedisWorkSource } from '../src/storage/redis/unit-of-work.js';
import { record } from './contracts/group-store.js';
import { RedisLiveGroups } from '../src/storage/redis/live-groups.js';
import {
  codeIndexContract,
  doorStateContract,
  endedGroupsContract,
  liveGroupsContract,
} from './contracts/state.js';
import { describeRedis, inspector, randomPrefix, testLink } from './helpers/redis.js';

describeRedis('Redis state contracts (#35 AC29)', () => {
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

  function setup(now: () => number, minutes = 100_000_000) {
    prefix = randomPrefix();
    const ctx = redisContext({
      link,
      keyPrefix: prefix,
      scheduler: { now, at: () => () => undefined },
      logger: createLogger({ level: 'silent' }),
      appOf: () => ({ maxSessionMinutes: minutes }) as never,
    });
    return { ctx, work: new RedisWorkSource(ctx) };
  }

  codeIndexContract('redis', {
    make: () => {
      const { ctx, work } = setup(() => 1_000);
      return Promise.resolve({
        index: new RedisCodeIndex(ctx, work),
        count: async () => (await inspect.keys(`${prefix}:v1:c`)).length,
      });
    },
    cleanup: () => inspect.flush(prefix),
  });

  endedGroupsContract('redis', {
    make: (cap) => {
      let time = 1_000;
      const warnings: object[] = [];
      const { ctx, work } = setup(() => time);
      const ended = new RedisEndedGroups(ctx, work, { warn: (obj) => warnings.push(obj) }, cap);
      return Promise.resolve({
        ended,
        warnings,
        advance: (ms: number) => {
          time += ms;
        },
        size: async () =>
          (await inspect.client.zCard(`${prefix}:v1:e:plain`)) +
          (await inspect.client.zCard(`${prefix}:v1:e:guarded`)),
      });
    },
    cleanup: () => inspect.flush(prefix),
  });

  liveGroupsContract('redis', {
    exactClock: false,
    make: () => {
      const { ctx, work } = setup(() => Date.now());
      return Promise.resolve({
        store: new RedisLiveGroups(ctx, work),
        now: () => Date.now(),
        advance: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        count: (namespace: string) =>
          inspect.client.zCount(`${prefix}:v1:lg:${namespace}`, Date.now(), '+inf'),
      });
    },
    cleanup: () => inspect.flush(prefix),
  });

  doorStateContract('redis', {
    make: async () => {
      const { ctx, work } = setup(() => 1_000);
      await new RedisGroupStore(ctx, work).create(record({ id: 'A'.repeat(43) }));
      return new RedisDoorStates(work);
    },
    cleanup: () => inspect.flush(prefix),
  });
});
