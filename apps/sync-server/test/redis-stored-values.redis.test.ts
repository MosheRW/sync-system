import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TokenSecretsInput } from '../src/config/token-secret.js';
import { endedRef } from '../src/groups/ended-groups.js';
import { createLogger } from '../src/logging/logger.js';
import type { RedisLink } from '../src/storage/redis/connect.js';
import { RedisCodeIndex } from '../src/storage/redis/codes.js';
import { RedisEndedGroups } from '../src/storage/redis/ended.js';
import { RedisEpoch } from '../src/storage/redis/epoch.js';
import { redisContext } from '../src/storage/redis/redis-storage.js';
import { RedisWorkSource } from '../src/storage/redis/unit-of-work.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { LogCapture } from './helpers/log-capture.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import { describeRedis, inspector, randomPrefix, testLink } from './helpers/redis.js';
import { type TestServer, startTestServer } from './helpers/test-server.js';

const MINUTE = 60_000;
const NOW = 1_800_000_000_000;
const NS = 'app-a';
const ID = 'G'.repeat(43);

/** Numbers that are not a stored time: NaN, text, negative, fraction, empty, too long. */
const BAD_NUMBERS = ['NaN', 'abc', '-1', '1.5', '', '1e9', '99999999999999999'];

/** Ended entries `{ns, d, g?}` that fail their check, including missing fields. */
const BAD_ENTRIES = [
  ...BAD_NUMBERS,
  '{',
  'null',
  '[]',
  `{"d":${NOW + MINUTE}}`,
  `{"ns":"${NS}"}`,
  `{"ns":"${NS}","d":"${NOW + MINUTE}"}`,
  `{"ns":"${NS}","d":-1}`,
  `{"ns":"${NS}","d":1.5}`,
  `{"ns":"${NS}","d":null}`,
  `{"ns":"${NS}","d":${NOW + MINUTE},"g":"x"}`,
];

/**
 * Security C1: every value read back from Redis is checked, and a value
 * that fails its check fails closed. It is logged as
 * `store_document_invalid` without the key or the value.
 */
describeRedis('invalid stored values fail closed (#35 security C1, M1)', () => {
  let link: RedisLink;
  let inspect: Awaited<ReturnType<typeof inspector>>;
  let prefix: string;
  let logs: LogCapture;

  beforeAll(async () => {
    link = await testLink(randomPrefix());
    inspect = await inspector();
  });
  afterAll(async () => {
    inspect.close();
    await link.close();
  });
  afterEach(async () => {
    await inspect.flush(prefix);
  });

  function make() {
    prefix = randomPrefix();
    logs = new LogCapture();
    const ctx = redisContext({
      link,
      keyPrefix: prefix,
      scheduler: new ManualScheduler(NOW),
      logger: createLogger({ level: 'trace', destination: logs }),
      appOf: () => ({ maxSessionMinutes: 60 }) as never,
    });
    const work = new RedisWorkSource(ctx);
    return {
      epoch: new RedisEpoch(ctx, work),
      ended: new RedisEndedGroups(ctx, work, ctx.logger),
      codes: new RedisCodeIndex(ctx, work),
    };
  }

  /** Logged as invalid, without the key or the value. */
  function expectLoggedWithout(...secrets: string[]): void {
    expect(logs.find('store_document_invalid')).toBeDefined();
    for (const secret of [prefix, ...secrets]) {
      if (secret.length > 3) expect(logs.text).not.toContain(secret);
    }
  }

  describe('the epoch', () => {
    it('a valid epoch is read as is', async () => {
      const { epoch } = make();
      await inspect.client.set(`${prefix}:v1:epoch`, '1234');
      expect(await epoch.current()).toBe(1234);
    });

    it('a missing epoch is created, not invalid', async () => {
      const { epoch } = make();
      expect(await epoch.current()).toBe(NOW);
      expect(logs.find('store_document_invalid')).toBeUndefined();
    });

    it.each(BAD_NUMBERS)('%j is 0: every token is from this epoch', async (bad) => {
      const { epoch } = make();
      await inspect.client.set(`${prefix}:v1:epoch`, bad);
      expect(await epoch.current()).toBe(0);
      expectLoggedWithout(bad);
      // The invalid value is never replaced by a fresh epoch.
      expect(await inspect.client.get(`${prefix}:v1:epoch`)).toBe(bad);
    });
  });

  describe('an ended entry', () => {
    it('a valid entry is ended until its deadline', async () => {
      const { ended } = make();
      const key = `${prefix}:v1:e:${endedRef(NS, ID)}`;
      await inspect.client.set(key, JSON.stringify({ ns: NS, d: NOW + MINUTE }));
      expect(await ended.has(NS, ID)).toBe(true);
      await inspect.client.set(key, JSON.stringify({ ns: NS, d: NOW - 1 }));
      expect(await ended.has(NS, ID)).toBe(false);
    });

    it.each(BAD_ENTRIES)('%j counts as ended', async (bad) => {
      const { ended } = make();
      await inspect.client.set(`${prefix}:v1:e:${endedRef(NS, ID)}`, bad);
      expect(await ended.has(NS, ID)).toBe(true);
      expectLoggedWithout(bad, endedRef(NS, ID));
    });
  });

  describe('the recovery closure', () => {
    it('a valid closure is closed until its end', async () => {
      const { ended } = make();
      await inspect.client.hSet(`${prefix}:v1:e:closed`, NS, String(NOW + MINUTE));
      expect(await ended.isRecoveryClosed(NS)).toBe(true);
      await inspect.client.hSet(`${prefix}:v1:e:closed`, NS, String(NOW - 1));
      expect(await ended.isRecoveryClosed(NS)).toBe(false);
    });

    it.each(BAD_NUMBERS)('%j counts as closed', async (bad) => {
      const { ended } = make();
      await inspect.client.hSet(`${prefix}:v1:e:closed`, NS, bad);
      expect(await ended.isRecoveryClosed(NS)).toBe(true);
      expectLoggedWithout(bad);
      // Other namespaces are not affected.
      expect(await ended.isRecoveryClosed('app-b')).toBe(false);
    });
  });

  describe('a code index value', () => {
    it('a group ID is the holder', async () => {
      const { codes } = make();
      await inspect.client.set(`${prefix}:v1:c:${NS}:g:123456`, ID);
      expect(await codes.lookup(NS, 'group', '123456')).toBe(ID);
    });

    it.each([...BAD_NUMBERS, 'G'.repeat(42), 'G'.repeat(44), `${'G'.repeat(42)}:`])(
      '%j is no holder',
      async (bad) => {
        const { codes } = make();
        await inspect.client.set(`${prefix}:v1:c:${NS}:g:123456`, bad);
        await inspect.client.set(`${prefix}:v1:c:${NS}:a:ABCDEFGH`, bad);
        expect(await codes.lookup(NS, 'group', '123456')).toBeUndefined();
        expect(await codes.lookup(NS, 'alpha', 'ABCDEFGH')).toBeUndefined();
      },
    );
  });
});

/** The same values through the server: no token recreates a group (AC13, AC14). */
describeRedis('invalid stored values stop recreation (#35 security C1, AC13)', () => {
  let inspect: Awaited<ReturnType<typeof inspector>>;
  let prefix: string;
  let secrets: TokenSecretsInput;
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
    const ts = await startTestServer({ redisPrefix: prefix, tokenSecrets: secrets, scheduler });
    servers.push(ts);
    return ts;
  }

  /** A group whose keys vanished while the server was down; returns its tokens. */
  async function lostGroup() {
    prefix = randomPrefix();
    secrets = { current: randomBytes(32), source: 'env' };
    scheduler = new ManualScheduler();
    const first = await start();
    const group = await createGroupWithMembers(first, 1);
    servers.splice(servers.indexOf(first), 1);
    await first.server.close();
    for (const key of await inspect.keys(`${prefix}:v1:g`)) await inspect.client.del(key);
    for (const key of await inspect.keys(`${prefix}:v1:p`)) await inspect.client.del(key);
    return group;
  }

  async function expectEnded(ts: TestServer, leaderToken: string): Promise<void> {
    const { reply } = await resumeWith(ts, leaderToken, { metadata: {} });
    expect(reply).toMatchObject({ type: 'error', code: 'GROUP_ENDED' });
    expect(await inspect.keys(`${prefix}:v1:g`)).toEqual([]);
  }

  it('control: after an epoch reset, the leader token recreates the group', async () => {
    const group = await lostGroup();
    await inspect.client.del(`${prefix}:v1:epoch`);
    const second = await start();
    const { reply } = await resumeWith(second, group.leaderToken, { metadata: {} });
    expect(reply).toMatchObject({ type: 'group.resumed', recreated: true });
  });

  it.each(BAD_NUMBERS)('an invalid epoch %j: the group has ended', async (bad) => {
    const group = await lostGroup();
    await inspect.client.set(`${prefix}:v1:epoch`, bad);
    const second = await start();
    await expectEnded(second, group.leaderToken);
    const checker = await second.connectReady();
    checker.send({ type: 'tokens.check', tokens: [group.leaderToken, group.memberTokens[0]] });
    expect(await checker.next('tokens.result')).toMatchObject({
      results: [{ status: 'ended' }, { status: 'ended' }],
    });
    expect(second.logs.find('store_document_invalid')).toBeDefined();
  });

  it.each(BAD_ENTRIES)('an invalid ended entry %j: the group has ended', async (bad) => {
    const group = await lostGroup();
    // A new epoch, so only the ended entry can stop the recreation: both
    // the classification (`has`) and the commit's re-check (C7) see it.
    await inspect.client.del(`${prefix}:v1:epoch`);
    await inspect.client.set(`${prefix}:v1:e:${endedRef('app-a', group.groupId)}`, bad);
    const second = await start();
    await expectEnded(second, group.leaderToken);
  });

  it.each(BAD_NUMBERS)('an invalid recovery closure %j: recovery stays closed', async (bad) => {
    const group = await lostGroup();
    await inspect.client.del(`${prefix}:v1:epoch`);
    await inspect.client.hSet(`${prefix}:v1:e:closed`, 'app-a', bad);
    const second = await start();
    const { reply } = await resumeWith(second, group.leaderToken, { metadata: {} });
    expect(reply).toMatchObject({ type: 'error', code: 'GROUP_ENDED' });
    expect(await inspect.keys(`${prefix}:v1:g`)).toEqual([]);
  });
});
