import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JoinMethod } from '@mosherw/sync-system-protocol';
import { parseEnv } from '../src/config/env.js';
import type { CodeIndex } from '../src/joins/code-index.js';
import { SlidingWindowRateLimiter } from '../src/limits/rate-limiter.js';
import { createLogger } from '../src/logging/logger.js';
import { AppRegistry } from '../src/apps/app-registry.js';
import { parseAppsConfig } from '../src/config/apps-config.js';
import { GroupService } from '../src/groups/group-service.js';
import { createSyncServer, groupCreateLimits } from '../src/server.js';
import { type Storage, memoryStorage } from '../src/storage/storage.js';
import { realScheduler } from '../src/time/scheduler.js';
import type { MemoryLiveGroups } from '../src/groups/live-groups.js';
import { MAX_CODE_DRAWS } from '../src/limits/constants.js';
import { ScriptedRandom } from './helpers/codes.js';
import { FailingStore } from './helpers/failing-store.js';
import { createGroupWithMembers, resumeWith } from './helpers/groups.js';
import { ManualScheduler } from './helpers/manual-scheduler.js';
import type { TestClient } from './helpers/test-client.js';
import {
  KEY_A,
  KEY_B,
  type StartOptions,
  TestClock,
  type TestServer,
  startTestServer,
} from './helpers/test-server.js';

const ALL: JoinMethod[] = ['A', 'B', 'C', 'D'];
const MINUTE = 60_000;

let ts: TestServer | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  await ts?.close();
  ts = undefined;
});

interface Started {
  server: TestServer;
  clock: TestClock;
  storage: Storage;
  /** Join code draws so far. */
  draws: () => number;
  /** Codes in the code index. */
  codes: () => number;
}

/** A server on memory storage that counts code draws (#12 AC1: zero draws on refusal). */
async function start(options: StartOptions = {}): Promise<Started> {
  const clock = new TestClock(1_767_225_600_000);
  const scheduler = realScheduler(clock.now);
  const storage = memoryStorage({ scheduler, logger: createLogger({ level: 'silent' }) });
  let draws = 0;
  ts = await startTestServer({
    scheduler,
    storage,
    codeRandom: (max) => {
      draws += 1;
      return Math.floor(Math.random() * max);
    },
    apps: [
      { namespace: 'app-a', apiKey: KEY_A, joinMethods: ALL, maxConnections: 1000 },
      { namespace: 'app-b', apiKey: KEY_B, joinMethods: ALL },
    ],
    env: { MAX_CONNECTIONS: '2000', MAX_APP_CONNECTIONS_CEILING: '1000' },
    ...options,
  });
  return {
    server: ts,
    clock,
    storage,
    draws: () => draws,
    codes: () => (storage.codes as CodeIndex).size,
  };
}

/** Sends one group.create and returns the reply. */
async function create(client: TestClient, joinMethods: JoinMethod[] = ['A', 'C']) {
  client.send({ type: 'group.create', reqId: 'c', metadata: {}, joinMethods });
  return client.next();
}

/** Creates a group and ends it, so the connection can create again. */
async function createAndEnd(client: TestClient): Promise<void> {
  expect(await create(client)).toMatchObject({ type: 'group.created' });
  client.send({ type: 'group.end', reqId: 'e' });
  await client.next('group.ended');
}

describe('group.create per connection (#12 AC1)', () => {
  it('allows 6 creates per minute, then RATE_LIMITED before any code is drawn', async () => {
    const { server, clock, draws, codes } = await start();
    const client = await server.connectReady();
    for (let i = 0; i < 6; i++) await createAndEnd(client);
    const drawsBefore = draws();
    const codesBefore = codes();
    const refused = await create(client);
    expect(refused).toEqual({
      type: 'error',
      reqId: 'c',
      code: 'RATE_LIMITED',
      message: 'Too many groups created; try later',
      details: { retryAfterMs: MINUTE },
    });
    expect(draws()).toBe(drawsBefore);
    expect(codes()).toBe(codesBefore);
    // The connection stays open and works once the window has passed.
    clock.advance(MINUTE);
    expect(await create(client)).toMatchObject({ type: 'group.created' });
  });

  it('counts every attempt, whatever its outcome, and a new connection starts afresh', async () => {
    const { server } = await start();
    const client = await server.connectReady();
    // Refused method sets count too (they come after the rate check).
    for (let i = 0; i < 6; i++) {
      expect(await create(client, ['A', 'B'])).toMatchObject({
        code: 'JOIN_METHOD_NOT_ALLOWED',
      });
    }
    expect(await create(client)).toMatchObject({ code: 'RATE_LIMITED' });
    await client.close();
    const fresh = await server.connectReady();
    expect(await create(fresh)).toMatchObject({ type: 'group.created' });
  });

  it('checks the method set before anything is drawn or stored (#12 M2)', async () => {
    const { server, draws, codes, storage } = await start();
    const reserve = vi.spyOn(storage.liveGroups, 'reserve');
    const client = await server.connectReady();
    expect(await create(client, ['A', 'B'])).toMatchObject({ code: 'JOIN_METHOD_NOT_ALLOWED' });
    expect(draws()).toBe(0);
    expect(codes()).toBe(0);
    expect(reserve).not.toHaveBeenCalled();
  });

  it('uses MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE from the env (R15)', async () => {
    const { server } = await start({
      env: {
        MAX_CONNECTIONS: '2000',
        MAX_APP_CONNECTIONS_CEILING: '1000',
        MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE: '2',
      },
    });
    const client = await server.connectReady();
    await createAndEnd(client);
    await createAndEnd(client);
    expect(await create(client)).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('forgets the connection on disconnect and everything on shutdown (R10)', async () => {
    const tracked = new Set<SlidingWindowRateLimiter>();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called with its own `this`
    const acquire = SlidingWindowRateLimiter.prototype.tryAcquire;
    vi.spyOn(SlidingWindowRateLimiter.prototype, 'tryAcquire').mockImplementation(function (
      this: SlidingWindowRateLimiter,
      key: string,
      limit: number,
    ) {
      // 7 is the per-connection create limit of this server and no other limit.
      if (limit === 7) tracked.add(this);
      return acquire.call(this, key, limit);
    });
    const { server } = await start({ groupLimits: { perConnection: 7 } });
    const first = await server.connectReady();
    const second = await server.connectReady();
    await createAndEnd(first);
    await createAndEnd(second);
    expect(tracked.size).toBe(1);
    const [limiter] = [...tracked];
    expect(limiter!.size).toBe(2);
    await first.close();
    await vi.waitFor(() => expect(limiter!.size).toBe(1));
    await ts!.close();
    ts = undefined;
    expect(limiter!.size).toBe(0);
  });
});

describe('group creation limits configuration (#12 R7, R15)', () => {
  const env = parseEnv({});

  it('reads the env values once, frozen', () => {
    const { limits, refillPerMinute } = groupCreateLimits(env);
    expect(limits).toEqual({
      perConnectionPerMinute: 6,
      appBurst: 120,
      appMaxPerMinute: 120,
      maxLiveGroups: 10_000,
    });
    expect(Object.isFrozen(limits)).toBe(true);
    expect(refillPerMinute).toBeUndefined();
    expect(
      groupCreateLimits(env, {
        perConnection: 2,
        appBurst: 3,
        appRefillPerMinute: 0.5,
        maxLiveGroups: 7,
      }),
    ).toEqual({
      limits: { perConnectionPerMinute: 2, appBurst: 3, appMaxPerMinute: 120, maxLiveGroups: 7 },
      refillPerMinute: 0.5,
    });
  });

  it('refuses invalid test-only overrides, the cross rule included', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      for (const field of ['perConnection', 'appBurst', 'maxLiveGroups'] as const) {
        expect(() => groupCreateLimits(env, { [field]: bad }), `${field}=${bad}`).toThrow(
          RangeError,
        );
      }
    }
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => groupCreateLimits(env, { appRefillPerMinute: bad })).toThrow(RangeError);
    }
    expect(() => groupCreateLimits(env, { maxLiveGroups: 240 })).toThrow(
      'maxLiveGroups must be > 2 * appBurst',
    );
    expect(() => groupCreateLimits(env, { appBurst: 5_000 })).toThrow(RangeError);
    expect(() => groupCreateLimits(env, { appBurst: 1, maxLiveGroups: 3 })).not.toThrow();
  });

  it('createSyncServer refuses an invalid groupLimits before binding anything', () => {
    const registry = new AppRegistry(
      parseAppsConfig(
        JSON.stringify({ apps: [{ namespace: 'app-a', apiKey: KEY_A, minAppVersion: '1.0.0' }] }),
        env,
      ),
    );
    expect(() =>
      createSyncServer({
        env,
        registry,
        logger: createLogger({ level: 'silent' }),
        tokenSecrets: { current: randomBytes(32), source: 'random' },
        groupLimits: { appBurst: 2, maxLiveGroups: 4 },
      }),
    ).toThrow(RangeError);
  });

  it('main.ts never passes groupLimits (test-only)', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main).not.toContain('groupLimits');
  });
});

/** The live groups of `namespace` in a memory storage. */
function liveCount(storage: Storage, namespace = 'app-a'): number {
  return (storage.liveGroups as MemoryLiveGroups).count(namespace);
}

/** A distinct valid group ID that no real group has. */
const FAKE = (letter: string) => letter.repeat(43);

describe('the per-app create budget (#12 AC2)', () => {
  const budget3 = { perConnection: 100, appBurst: 3, appRefillPerMinute: 1, maxLiveGroups: 100 };

  it('refuses over the burst with RATE_LIMITED before any code is drawn, then refills', async () => {
    const { server, clock, draws, codes, storage } = await start({ groupLimits: budget3 });
    const clients = await Promise.all([1, 2, 3, 4].map(() => server.connectReady()));
    for (const client of clients.slice(0, 3)) {
      expect(await create(client)).toMatchObject({ type: 'group.created' });
    }
    const drawsBefore = draws();
    const codesBefore = codes();
    expect(await create(clients[3]!)).toEqual({
      type: 'error',
      reqId: 'c',
      code: 'RATE_LIMITED',
      message: 'Too many groups created; try later',
      details: { retryAfterMs: MINUTE },
    });
    expect(draws()).toBe(drawsBefore);
    expect(codes()).toBe(codesBefore);
    expect(liveCount(storage)).toBe(3);
    clock.advance(MINUTE);
    expect(await create(clients[3]!)).toMatchObject({ type: 'group.created' });
    expect(liveCount(storage)).toBe(4);
  });

  it('a connection over its own limit never spends the app budget', async () => {
    const { server } = await start({ groupLimits: { ...budget3, perConnection: 1 } });
    const greedy = await server.connectReady();
    await createAndEnd(greedy);
    for (let i = 0; i < 5; i++) {
      expect(await create(greedy)).toMatchObject({ code: 'RATE_LIMITED' });
    }
    // Two tokens are left for everyone else.
    for (let i = 0; i < 2; i++) {
      const other = await server.connectReady();
      expect(await create(other)).toMatchObject({ type: 'group.created' });
    }
  });

  it('attempts the app budget refused still count against the connection (M4 pin)', async () => {
    const { server, storage } = await start({
      groupLimits: { perConnection: 6, appBurst: 1, appRefillPerMinute: 1, maxLiveGroups: 100 },
    });
    const reserve = vi.spyOn(storage.liveGroups, 'reserve');
    const poller = await server.connectReady();
    await createAndEnd(poller);
    for (let i = 0; i < 5; i++) {
      expect(await create(poller)).toMatchObject({ code: 'RATE_LIMITED' });
    }
    expect(reserve).toHaveBeenCalledTimes(6);
    // The 7th attempt is refused by the connection's own limit: no reserve.
    expect(await create(poller)).toMatchObject({ code: 'RATE_LIMITED' });
    expect(reserve).toHaveBeenCalledTimes(6);
  });
});

describe('the live-group cap (#12 AC3)', () => {
  const cap3 = { perConnection: 100, appBurst: 1, appRefillPerMinute: 1, maxLiveGroups: 3 };

  it('refuses at the cap with APP_GROUP_LIMIT, draws nothing and charges nothing', async () => {
    const { server, clock, draws, codes, storage } = await start({ groupLimits: cap3 });
    // Two abandoned groups and one with its leader still connected.
    for (let i = 0; i < 2; i++) {
      const abandoned = await server.connectReady();
      expect(await create(abandoned)).toMatchObject({ type: 'group.created' });
      await abandoned.close();
      clock.advance(MINUTE);
    }
    const leader = await server.connectReady();
    expect(await create(leader)).toMatchObject({ type: 'group.created' });
    expect(liveCount(storage)).toBe(3);
    clock.advance(MINUTE);
    const drawsBefore = draws();
    const codesBefore = codes();
    const stored = (storage.groups as unknown as { size: number }).size;
    const client = await server.connectReady();
    for (let i = 0; i < 2; i++) {
      expect(await create(client)).toEqual({
        type: 'error',
        reqId: 'c',
        code: 'APP_GROUP_LIMIT',
        message: 'The app has too many live groups; try later',
        details: { maxLiveGroups: 3 },
      });
    }
    expect(draws()).toBe(drawsBefore);
    expect(codes()).toBe(codesBefore);
    expect((storage.groups as unknown as { size: number }).size).toBe(stored);
    expect(liveCount(storage)).toBe(3);
    // One group ends: a create works at once, on the token the refusals left.
    leader.send({ type: 'group.end', reqId: 'e' });
    await leader.next('group.ended');
    expect(liveCount(storage)).toBe(2);
    expect(await create(client)).toMatchObject({ type: 'group.created' });
  });

  it('uses MAX_LIVE_GROUPS_PER_APP and MAX_GROUP_CREATE_BURST_PER_APP from the env (R15)', async () => {
    const { server, clock, storage } = await start({
      env: {
        MAX_CONNECTIONS: '2000',
        MAX_APP_CONNECTIONS_CEILING: '1000',
        MAX_LIVE_GROUPS_PER_APP: '3',
        MAX_GROUP_CREATE_BURST_PER_APP: '1',
      },
    });
    const far = clock.now() + 3_600_000;
    for (const letter of ['X', 'Y', 'Z']) {
      await storage.liveGroups.register('app-a', FAKE(letter), far);
    }
    const client = await server.connectReady();
    expect(await create(client)).toMatchObject({
      code: 'APP_GROUP_LIMIT',
      details: { maxLiveGroups: 3 },
    });
  });

  it('keeps budgets and caps per app (AC4)', async () => {
    const { server, storage } = await start({ groupLimits: cap3 });
    const a = await server.connectReady(KEY_A);
    expect(await create(a)).toMatchObject({ type: 'group.created' });
    // app-a: budget empty and, with two more slots taken, at its cap.
    const far = Date.now() + 3_600_000 * 1_000;
    await storage.liveGroups.register('app-a', FAKE('X'), far);
    await storage.liveGroups.register('app-a', FAKE('Y'), far);
    expect(await create(await server.connectReady(KEY_A))).toMatchObject({ code: 'RATE_LIMITED' });
    const b = await server.connectReady(KEY_B);
    expect(await create(b)).toMatchObject({ type: 'group.created' });
    expect(liveCount(storage, 'app-b')).toBe(1);
  });
});

describe('every path after a reservation stores the group or releases its slot (#12 R4)', () => {
  it('CODES_EXHAUSTED releases the slot', async () => {
    const random = new ScriptedRandom();
    const { server, storage } = await start({ codeRandom: random.next });
    const first = await server.connectReady();
    random.queue(7);
    expect(await create(first, ['A'])).toMatchObject({ type: 'group.created' });
    expect(liveCount(storage)).toBe(1);
    // Every draw of the next group code hits the taken one.
    random.queue(...Array<number>(MAX_CODE_DRAWS).fill(7));
    const second = await server.connectReady();
    expect(await create(second, ['A'])).toMatchObject({ code: 'CODES_EXHAUSTED' });
    expect(liveCount(storage)).toBe(1);
  });

  it('a throwing store.create releases the slot', async () => {
    const failing = new FailingStore();
    const clock = new TestClock(1_767_225_600_000);
    const scheduler = realScheduler(clock.now);
    const storage = memoryStorage({
      scheduler,
      logger: createLogger({ level: 'silent' }),
      groups: failing,
    });
    ts = await startTestServer({ scheduler, storage });
    const client = await ts.connectReady();
    failing.failNext('create');
    expect(await create(client, ['A', 'D'])).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(liveCount(storage)).toBe(0);
    expect(await create(client, ['A', 'D'])).toMatchObject({ type: 'group.created' });
    expect(liveCount(storage)).toBe(1);
  });

  it('a disallowed method set makes no reservation at all', async () => {
    const { server, storage } = await start();
    const reserve = vi.spyOn(storage.liveGroups, 'reserve');
    const client = await server.connectReady();
    expect(await create(client, ['A', 'B'])).toMatchObject({ code: 'JOIN_METHOD_NOT_ALLOWED' });
    expect(reserve).not.toHaveBeenCalled();
    expect(liveCount(storage)).toBe(0);
  });
});

describe('recreations are counted, never refused, never charged (#12 Q-4, R8)', () => {
  it('a recreation at the cap succeeds, counts, and the next create gets APP_GROUP_LIMIT', async () => {
    const tokenSecrets = { current: randomBytes(32), source: 'env' as const };
    const scheduler = new ManualScheduler();
    ts = await startTestServer({ tokenSecrets, scheduler });
    const group = await createGroupWithMembers(ts, 0);
    await ts.close();

    // A new process at its cap: the bucket is full (one token).
    scheduler.advance(2 * MINUTE);
    const storage = memoryStorage({ scheduler, logger: createLogger({ level: 'silent' }) });
    ts = await startTestServer({
      tokenSecrets,
      scheduler,
      storage,
      groupLimits: { appBurst: 1, appRefillPerMinute: 1, maxLiveGroups: 3 },
    });
    const far = scheduler.now() + 3_600_000;
    for (const letter of ['X', 'Y', 'Z']) {
      await storage.liveGroups.register('app-a', FAKE(letter), far);
    }
    const { reply } = await resumeWith(ts, group.leaderToken, { metadata: {}, blockList: [] });
    expect(reply).toMatchObject({ type: 'group.resumed', recreated: true });
    expect(liveCount(storage)).toBe(4);
    // Not charged: the token is still there, so the refusal is the cap's.
    const client = await ts.connectReady();
    expect(await create(client, ['A', 'D'])).toMatchObject({ code: 'APP_GROUP_LIMIT' });
  });
});

/** The records of one event. */
function warnings(server: TestServer, event: string): Array<Record<string, unknown>> {
  return server.logs.records().filter((record) => record.event === event);
}

/** A record's fields apart from pino's own and the event name. */
function ownFields(record: Record<string, unknown>): string[] {
  const base = ['level', 'time', 'pid', 'hostname', 'msg', 'event', 'v'];
  return Object.keys(record).filter((key) => !base.includes(key));
}

describe('refusal logs (#12 AC5, R9)', () => {
  it('warn once per minute per app, with the namespace only; nothing for per-connection refusals', async () => {
    const { server, clock } = await start({
      groupLimits: { perConnection: 2, appBurst: 1, appRefillPerMinute: 1, maxLiveGroups: 3 },
    });
    const first = await server.connectReady();
    const created = await create(first);
    if (created.type !== 'group.created') throw new Error('expected created');
    // Budget refusals: two in the same minute, one warning.
    const second = await server.connectReady();
    expect(await create(second)).toMatchObject({ code: 'RATE_LIMITED' });
    expect(await create(second)).toMatchObject({ code: 'RATE_LIMITED' });
    // A per-connection refusal: no warning.
    expect(await create(second)).toMatchObject({ code: 'RATE_LIMITED' });
    const budget = warnings(server, 'group_create_app_budget_exhausted');
    expect(budget).toHaveLength(1);
    expect(budget[0]).toMatchObject({ level: 40, namespace: 'app-a' });
    // The cap: fill it, then two refusals in one minute, one warning.
    clock.advance(MINUTE);
    const third = await server.connectReady();
    expect(await create(third)).toMatchObject({ type: 'group.created' });
    clock.advance(MINUTE);
    const fourth = await server.connectReady();
    expect(await create(fourth)).toMatchObject({ type: 'group.created' });
    clock.advance(MINUTE);
    const fifth = await server.connectReady();
    expect(await create(fifth)).toMatchObject({ code: 'APP_GROUP_LIMIT' });
    expect(await create(fifth)).toMatchObject({ code: 'APP_GROUP_LIMIT' });
    const capped = warnings(server, 'app_group_limit_reached');
    expect(capped).toHaveLength(1);
    for (const warning of [...budget, ...capped]) expect(ownFields(warning)).toEqual(['namespace']);
    // Never a code, a group ID or ref, or a connection ID.
    const text = server.logs.text;
    for (const warning of [...budget, ...capped]) {
      const line = JSON.stringify({ namespace: warning.namespace, msg: warning.msg });
      expect(line).not.toMatch(/\d{6}/);
      expect(line).not.toContain(created.groupId);
    }
    expect(text).not.toContain(created.codes.groupCode ?? 'no-group-code');
  });
});

/**
 * #48: the private `forgetGroup` also runs for the cluster `forget` op, so
 * it must never give the live-group slot back; only `endGroup` does, in the
 * same commit as the delete (#12 R6). The service is reached through the
 * class prototype (no test-only export): a call-through spy on `create`
 * records the instance that serves the server.
 */
describe('a group that is only forgotten keeps its slot (#48)', () => {
  type Forgetter = { forgetGroup(ns: string, gid: string, record: undefined): Promise<void> };

  it('forgetGroup leaves the slot taken; group.end gives it back exactly once', async () => {
    const created = vi.spyOn(GroupService.prototype, 'create');
    const { server, storage } = await start();
    const release = vi.spyOn(storage.liveGroups, 'release');
    const leader = await server.connectReady();
    const reply = await create(leader);
    expect(reply).toMatchObject({ type: 'group.created' });
    const groupId = (reply as { groupId: string }).groupId;
    expect(liveCount(storage)).toBe(1);

    const service = created.mock.contexts[0] as Forgetter;
    await service.forgetGroup('app-a', groupId, undefined);
    expect(liveCount(storage)).toBe(1);
    expect(release).not.toHaveBeenCalled();

    leader.send({ type: 'group.end', reqId: 'e' });
    await leader.next('group.ended');
    expect(liveCount(storage)).toBe(0);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith('app-a', groupId);
  });
});
