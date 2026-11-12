import { afterAll, beforeAll, expect, it } from 'vitest';
import { endedRef } from '../src/groups/ended-groups.js';
import { GroupLock } from '../src/groups/group-lock.js';
import { createLogger } from '../src/logging/logger.js';
import { StorageInvalidError } from '../src/storage/errors.js';
import type { RedisLink } from '../src/storage/redis/connect.js';
import { RedisEndedGroups } from '../src/storage/redis/ended.js';
import { RedisEpoch } from '../src/storage/redis/epoch.js';
import { RedisGroupStore } from '../src/storage/redis/group-store.js';
import { redisContext } from '../src/storage/redis/redis-storage.js';
import { type RedisContext, RedisWorkSource } from '../src/storage/redis/unit-of-work.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { LogCapture } from './helpers/log-capture.js';
import { describeRedis, inspector, randomPrefix, testLink } from './helpers/redis.js';
import { ID, groupStoreContract, record } from './contracts/group-store.js';

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;

describeRedis('RedisGroupStore (#35 AC7, AC24, AC29, ADR 0011)', () => {
  let link: RedisLink;
  let inspect: Awaited<ReturnType<typeof inspector>>;
  let prefix = randomPrefix();
  let logs = new LogCapture();

  /** `minutes` of max session; the contract's records are created at 1 (1970). */
  function context(minutes: number): RedisContext {
    return redisContext({
      link,
      keyPrefix: prefix,
      scheduler: new ManualScheduler(NOW),
      logger: createLogger({ level: 'trace', destination: logs }),
      appOf: () => ({ maxSessionMinutes: minutes }) as never,
    });
  }

  function make(minutes = 60) {
    const ctx = context(minutes);
    const work = new RedisWorkSource(ctx);
    return { ctx, work, store: new RedisGroupStore(ctx, work), epoch: new RedisEpoch(ctx, work) };
  }

  beforeAll(async () => {
    link = await testLink(prefix);
    inspect = await inspector();
  });

  afterAll(async () => {
    await inspect.flush(prefix);
    inspect.close();
    await link.close();
  });

  groupStoreContract('RedisGroupStore', {
    make: () => {
      prefix = randomPrefix();
      const { store } = make(100_000_000);
      return Promise.resolve({
        store,
        count: async () => (await inspect.keys(`${prefix}:v1:g`)).length,
      });
    },
    cleanup: () => inspect.flush(prefix),
  });

  it('keeps every key of a group no longer than its end bound E (AC24)', async () => {
    prefix = randomPrefix();
    const { store } = make();
    await store.create(record({ createdAt: NOW }));
    // The clock is NOW: every key lives at most max session + 5 s.
    for (const key of await inspect.keys(prefix)) {
      const ttl = await inspect.client.pTTL(key);
      expect(ttl, key).toBeGreaterThan(0);
      // The epoch outlives the groups by the clock skew, then goes too (F12).
      const bound = key.endsWith(':epoch') ? 65 * MINUTE + 5000 : 60 * MINUTE + 5000;
      expect(ttl, key).toBeLessThanOrEqual(bound);
    }
    await store.delete('app-a', ID);
    // Only the epoch (deployment metadata, no group data) stays, with its TTL.
    expect(await inspect.keys(prefix)).toEqual([`${prefix}:v1:epoch`]);
    await inspect.flush(prefix);
  });

  it('writes only the small position key on a position update (F10)', async () => {
    prefix = randomPrefix();
    const { store } = make();
    await store.create(record({ createdAt: NOW }));
    const docKey = `${prefix}:v1:g:app-a:${ID}`;
    const posKey = `${prefix}:v1:p:app-a:${ID}`;
    const doc = await inspect.client.get(docKey);
    const docTtl = await inspect.client.pExpireTime(docKey);
    await store.setPosition('app-a', ID, { page: 7 }, NOW + 1);
    expect(await inspect.client.get(docKey)).toBe(doc);
    expect(await inspect.client.pExpireTime(docKey)).toBe(docTtl);
    expect(JSON.parse((await inspect.client.get(posKey))!)).toMatchObject({
      position: { has: true, payload: { page: 7 } },
    });
    await inspect.flush(prefix);
  });

  it('treats an invalid document as an error, never as missing (C1)', async () => {
    prefix = randomPrefix();
    logs = new LogCapture();
    const { store } = make();
    await store.create(record({ createdAt: NOW }));
    const docKey = `${prefix}:v1:g:app-a:${ID}`;
    for (const bad of ['{', '{"v":2}', '{"v":1,"record":{"id":"x"}}', '[]', '"text"']) {
      await inspect.client.set(docKey, bad);
      await expect(store.get('app-a', ID)).rejects.toBeInstanceOf(StorageInvalidError);
      await expect(store.createIfAbsent(record())).rejects.toBeInstanceOf(StorageInvalidError);
    }
    expect(logs.text).toContain('store_document_invalid');
    expect(logs.text).not.toContain(ID);
    expect(logs.text).not.toContain(prefix);
    await inspect.flush(prefix);
  });

  it('commits a locked task once, and writes nothing when the task fails (AC26)', async () => {
    prefix = randomPrefix();
    const { store, work } = make();
    await store.create(record({ createdAt: NOW, participantIds: ['leader'] }));
    const docKey = `${prefix}:v1:g:app-a:${ID}`;
    const before = await inspect.client.get(docKey);
    const lock = new GroupLock(work);
    await expect(
      lock.run('app-a', ID, async () => {
        await store.addParticipant('app-a', ID, 'm1', 10);
        await store.patch('app-a', ID, { locked: true });
        // Seen inside the task, not yet in Redis.
        expect((await store.get('app-a', ID))!.participantIds).toEqual(['leader', 'm1']);
        expect(await inspect.client.get(docKey)).toBe(before);
        throw new Error('fails after two writes');
      }),
    ).rejects.toThrow('fails after two writes');
    expect(await inspect.client.get(docKey)).toBe(before);

    await lock.run('app-a', ID, async () => {
      await store.addParticipant('app-a', ID, 'm1', 10);
      await store.patch('app-a', ID, { locked: true });
    });
    expect(await store.get('app-a', ID)).toMatchObject({
      participantIds: ['leader', 'm1'],
      locked: true,
    });
    await inspect.flush(prefix);
  });

  it('a recreation commit finds a group stored meanwhile and writes nothing (C7)', async () => {
    prefix = randomPrefix();
    const { store, work, epoch } = make();
    const lock = new GroupLock(work);
    await expect(
      lock.run('app-a', ID, async () => {
        // A recreation classifies the token against the epoch first.
        await epoch.current();
        expect(await store.createIfAbsent(record({ leaderId: 'a', createdAt: NOW }))).toBe(
          'created',
        );
        // Another writer stores the group before this commit.
        const other = make().store;
        await other.create(record({ leaderId: 'b', createdAt: NOW }));
      }),
    ).rejects.toMatchObject({ name: 'StorageConflictError', reason: 'exists' });
    expect((await store.get('app-a', ID))!.leaderId).toBe('b');
    await inspect.flush(prefix);
  });

  it('a recreation in a task that never read the epoch aborts and writes nothing (C7, L2)', async () => {
    prefix = randomPrefix();
    const { store, work } = make();
    const lock = new GroupLock(work);
    await expect(
      lock.run('app-a', ID, async () => {
        expect(await store.createIfAbsent(record({ createdAt: NOW }))).toBe('created');
      }),
    ).rejects.toMatchObject({ name: 'StorageConflictError', reason: 'epoch' });
    expect(await inspect.keys(prefix)).toEqual([]);
  });

  it('a recreation commit finds the group ended meanwhile and writes nothing (C7)', async () => {
    prefix = randomPrefix();
    const { store, work, epoch } = make();
    const lock = new GroupLock(work);
    await expect(
      lock.run('app-a', ID, async () => {
        await epoch.current();
        expect(await store.createIfAbsent(record({ createdAt: NOW }))).toBe('created');
        // Another writer ends the group before this commit.
        const other = make();
        const ended = new RedisEndedGroups(other.ctx, other.work, other.ctx.logger);
        await ended.remember('app-a', ID, NOW + MINUTE);
      }),
    ).rejects.toMatchObject({ name: 'StorageConflictError', reason: 'ended' });
    expect(await inspect.keys(`${prefix}:v1:g`)).toEqual([]);
    expect(await inspect.keys(`${prefix}:v1:p`)).toEqual([]);
    expect(await inspect.client.get(`${prefix}:v1:e:${endedRef('app-a', ID)}`)).not.toBeNull();
    await inspect.flush(prefix);
  });

  it('a recreation commit finds the epoch changed meanwhile and writes nothing (C7)', async () => {
    prefix = randomPrefix();
    const { store, work, epoch } = make();
    const lock = new GroupLock(work);
    await expect(
      lock.run('app-a', ID, async () => {
        await epoch.current();
        expect(await store.createIfAbsent(record({ createdAt: NOW }))).toBe('created');
        // Redis lost its data and a new epoch was set before this commit.
        await inspect.client.set(`${prefix}:v1:epoch`, String(NOW + 1));
      }),
    ).rejects.toMatchObject({ name: 'StorageConflictError', reason: 'epoch' });
    expect(await inspect.keys(`${prefix}:v1:g`)).toEqual([]);
    expect(await inspect.keys(`${prefix}:v1:p`)).toEqual([]);
    expect(await inspect.client.get(`${prefix}:v1:epoch`)).toBe(String(NOW + 1));
    await inspect.flush(prefix);
  });

  it('create sets a missing epoch and keeps an existing one (C7)', async () => {
    prefix = randomPrefix();
    const { store } = make();
    expect(await inspect.client.get(`${prefix}:v1:epoch`)).toBeNull();
    await store.create(record({ createdAt: NOW }));
    expect(await inspect.client.get(`${prefix}:v1:epoch`)).toBe(String(NOW));
    await store.delete('app-a', ID);
    await inspect.client.set(`${prefix}:v1:epoch`, '5');
    await store.create(record({ createdAt: NOW }));
    expect(await inspect.client.get(`${prefix}:v1:epoch`)).toBe('5');
    await inspect.flush(prefix);
  });
});
