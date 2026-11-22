import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JoinMethod } from '@sync-system/protocol';
import { parseEnv } from '../src/config/env.js';
import type { CodeIndex } from '../src/joins/code-index.js';
import { SlidingWindowRateLimiter } from '../src/limits/rate-limiter.js';
import { createLogger } from '../src/logging/logger.js';
import { AppRegistry } from '../src/apps/app-registry.js';
import { parseAppsConfig } from '../src/config/apps-config.js';
import { createSyncServer, groupCreateLimits } from '../src/server.js';
import { type Storage, memoryStorage } from '../src/storage/storage.js';
import { realScheduler } from '../src/time/scheduler.js';
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
