import { randomBytes } from 'node:crypto';
import { AppRegistry } from '../../src/apps/app-registry.js';
import { parseAppsConfig } from '../../src/config/apps-config.js';
import { parseEnv } from '../../src/config/env.js';
import type { LogLevel } from '../../src/config/env.js';
import { createLogger } from '../../src/logging/logger.js';
import { type SyncServer, type SyncServerOptions, createSyncServer } from '../../src/server.js';
import { type ClusterTimings, redisStorage } from '../../src/storage/redis/redis-storage.js';
import { realScheduler } from '../../src/time/scheduler.js';
import { LogCapture } from './log-capture.js';
import { randomPrefix, testLink } from './redis.js';
import type { RedisLink } from '../../src/storage/redis/connect.js';
import { TestClient } from './test-client.js';

export const KEY_A = 'test-key-app-a-0123456789-0123456789-abcdef';
export const KEY_B = 'test-key-app-b-0123456789-0123456789-abcdef';

export interface TestAppInput {
  namespace: string;
  apiKey: string;
  minAppVersion?: string;
  maxGroupSize?: number;
  maxLeaderUpdatesPerSecond?: number;
  maxMessageBytes?: number;
  maxConnections?: number;
  maxSessionMinutes?: number;
  inactivityLimitMinutes?: number;
  joinMethods?: string[];
  qrTicketSeconds?: number;
  approvalTimeoutSeconds?: number;
  disconnectGraceSeconds?: number;
  keepAliveCountdownSeconds?: number;
  defaultHandoff?: string;
}

export const DEFAULT_TEST_APPS: TestAppInput[] = [
  { namespace: 'app-a', apiKey: KEY_A },
  { namespace: 'app-b', apiKey: KEY_B },
];

/**
 * How far a simulated restart moves the clock ahead (#13 6.9 layer 2):
 * tokens of an earlier instance must have an `iat` before the second the
 * new instance started, or the new instance treats them as its own.
 */
export const RESTART_CLOCK_STEP_MS = 1_500;

/** Instances started per secrets object and per manual scheduler. */
const startsBySecrets = new WeakMap<object, number>();
const startsByScheduler = new WeakMap<object, number>();

/**
 * A restart is simulated by a new instance on the same token secrets (or
 * the same manual scheduler). Each such instance runs its clock
 * RESTART_CLOCK_STEP_MS further ahead: a manual scheduler is advanced, a
 * real clock is offset. A first instance keeps the clock as it is.
 */
function restartClock(options: StartOptions): Pick<StartOptions, 'now'> {
  const scheduler = options.scheduler as { advance?: (ms: number) => void } | undefined;
  if (scheduler !== undefined) {
    const starts = startsByScheduler.get(scheduler) ?? 0;
    startsByScheduler.set(scheduler, starts + 1);
    if (starts > 0) scheduler.advance?.(RESTART_CLOCK_STEP_MS);
    return {};
  }
  if (options.now !== undefined || options.tokenSecrets === undefined) return {};
  const starts = startsBySecrets.get(options.tokenSecrets) ?? 0;
  startsBySecrets.set(options.tokenSecrets, starts + 1);
  if (starts === 0) return {};
  const offset = starts * RESTART_CLOCK_STEP_MS;
  return { now: () => Date.now() + offset };
}

/** A manually advanced clock for rate limiter tests. */
export class TestClock {
  constructor(public time = 1_000_000) {}
  now = (): number => this.time;
  advance(ms: number): void {
    this.time += ms;
  }
}

export interface StartOptions extends Partial<
  Omit<SyncServerOptions, 'env' | 'registry' | 'logger'>
> {
  /** Env variables as strings, exactly as the process would see them. */
  env?: Record<string, string>;
  apps?: TestAppInput[];
  logLevel?: LogLevel;
  /** Runs on the test Redis under this key prefix (#35; needs SYNC_TEST_REDIS_URL). */
  redisPrefix?: string;
  /** The Redis connection to use with `redisPrefix` (e.g. through a TCP proxy). */
  redisLink?: RedisLink;
  /** Shorter several-instance timings (#35 architecture 12.13). */
  redisTimings?: Partial<ClusterTimings>;
  /** The monotonic clock of the self-fence (#35 security C11 tests). */
  monotonic?: () => number;
}

export interface TestServer {
  server: SyncServer;
  port: number;
  url: string;
  logs: LogCapture;
  registry: AppRegistry;
  /** Connects a client (does not send hello). */
  connect(): Promise<TestClient>;
  /** Connects and completes the handshake with `apiKey` (default app A). */
  connectReady(apiKey?: string): Promise<TestClient>;
  close(): Promise<void>;
}

export async function startTestServer(options: StartOptions = {}): Promise<TestServer> {
  const {
    env: envOverrides,
    apps,
    logLevel,
    redisPrefix,
    redisLink,
    redisTimings,
    monotonic,
    ...rest
  } = { ...options, ...restartClock(options) };
  const env = parseEnv({ LOG_LEVEL: logLevel ?? 'trace', ...envOverrides });
  const appInputs = (apps ?? DEFAULT_TEST_APPS).map((app) => ({ minAppVersion: '1.0.0', ...app }));
  const registry = new AppRegistry(parseAppsConfig(JSON.stringify({ apps: appInputs }), env));
  const logs = new LogCapture();
  const logger = createLogger({ level: env.logLevel, destination: logs });
  // A random per-instance secret unless the test passes its own (#7 L1:
  // createSyncServer itself no longer has a fallback).
  const tokenSecrets = rest.tokenSecrets ?? { current: randomBytes(32), source: 'random' };
  let storage = rest.storage;
  // SYNC_TEST_STORE=redis runs every server suite on the test Redis (#35 AC1, AC22).
  const prefix =
    redisPrefix ??
    (process.env.SYNC_TEST_STORE === 'redis' && rest.store === undefined
      ? randomPrefix()
      : undefined);
  if (prefix !== undefined && storage === undefined) {
    const scheduler = rest.scheduler ?? realScheduler(rest.now ?? Date.now);
    rest.scheduler = scheduler;
    const byNamespace = new Map(registry.apps().map((app) => [app.namespace, app]));
    storage = redisStorage({
      link: redisLink ?? (await testLink(prefix, logger)),
      keyPrefix: prefix,
      scheduler,
      logger,
      appOf: (namespace) => byNamespace.get(namespace),
      ...(rest.endedGroupsCap === undefined ? {} : { endedGroupsCap: rest.endedGroupsCap }),
      ...(redisTimings === undefined ? {} : { timings: redisTimings }),
      ...(monotonic === undefined ? {} : { monotonic }),
    });
  }
  const server = createSyncServer({
    env,
    registry,
    logger,
    ...rest,
    ...(storage === undefined ? {} : { storage }),
    tokenSecrets,
  });
  const port = await server.listen(0, '127.0.0.1');
  const url = `ws://127.0.0.1:${port}/ws`;
  const clients: TestClient[] = [];

  const connect = async () => {
    const client = await TestClient.connect(url);
    clients.push(client);
    return client;
  };

  return {
    server,
    port,
    url,
    logs,
    registry,
    connect,
    async connectReady(apiKey = KEY_A) {
      const client = await connect();
      const reply = await client.hello({ apiKey });
      if (reply.type !== 'hello.ok') throw new Error(`hello failed: ${JSON.stringify(reply)}`);
      return client;
    },
    async close() {
      for (const client of clients) client.terminate();
      await server.close();
    },
  };
}

/** Plain HTTP GET against the test server. */
export async function httpGet(
  port: number,
  path: string,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Non-JSON body: keep the text.
  }
  return { status: res.status, body, headers: res.headers };
}
