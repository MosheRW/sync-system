import { randomBytes } from 'node:crypto';
import { parseRedisSettings } from '../../src/config/redis.js';
import type { TokenSecrets } from '../../src/config/token-secret.js';
import { createLogger } from '../../src/logging/logger.js';
import { type RedisLink, connectRedis } from '../../src/storage/redis/connect.js';
import type { ClusterTimings } from '../../src/storage/redis/redis-storage.js';
import { TEST_REDIS_URL, randomPrefix } from './redis.js';
import { TcpProxy } from './tcp-proxy.js';
import { type StartOptions, type TestServer, startTestServer } from './test-server.js';

/**
 * Short several-instance timings for tests (#35 architecture 12.13): the
 * same ratios as the fixed ones (liveness > self-fence > heartbeat).
 */
export const FAST_TIMINGS: Partial<ClusterTimings> = {
  livenessMs: 1_500,
  heartbeatMs: 150,
  selfFenceMs: 1_000,
  leaseMs: 1_000,
  renewMs: 300,
  maxHoldMs: 3_000,
  waitMs: 1_000,
  sweepMs: 300,
};

/** One instance of a test cluster, with its own TCP proxy to Redis (to partition it). */
export interface ClusterNode {
  ts: TestServer;
  proxy: TcpProxy;
  link: RedisLink;
}

export interface TestCluster {
  prefix: string;
  secrets: TokenSecrets;
  nodes: ClusterNode[];
  /** Starts one more instance on the same prefix. */
  add(): Promise<ClusterNode>;
  /** A clean stop of one instance (its stored attachments stay for the sweep). */
  stop(node: ClusterNode): Promise<void>;
  close(): Promise<void>;
}

export interface ClusterOptions extends Omit<StartOptions, 'redisPrefix' | 'redisLink'> {
  /** Instances to start (default 2). */
  size?: number;
  /** Options for the instance with this index only (e.g. a test hook). */
  perNode?: (index: number) => Partial<StartOptions>;
  /** Redis command timeout of every link (default 500 ms). */
  commandTimeoutMs?: number;
}

/**
 * N in-process servers on one random prefix (#35 architecture 12.17): one
 * token secret and apps config, each with its own Redis links through its
 * own TCP proxy and short timings. Clocks are real and not offset, like
 * several hosts with NTP.
 */
export async function startCluster(options: ClusterOptions = {}): Promise<TestCluster> {
  const { size = 2, perNode, commandTimeoutMs = 500, ...rest } = options;
  let started = 0;
  const prefix = randomPrefix();
  const secrets: TokenSecrets = rest.tokenSecrets ?? {
    current: randomBytes(32),
    source: 'env',
  };
  const nodes: ClusterNode[] = [];

  async function add(): Promise<ClusterNode> {
    const target = new URL(TEST_REDIS_URL!);
    const proxy = await TcpProxy.start(target.hostname, Number(target.port || 6379));
    const url = new URL(TEST_REDIS_URL!);
    url.hostname = '127.0.0.1';
    url.port = String(proxy.port);
    const connected = await connectRedis(
      parseRedisSettings({
        REDIS_URL: url.toString(),
        REDIS_KEY_PREFIX: prefix,
        REDIS_COMMAND_TIMEOUT_MS: String(commandTimeoutMs),
        REDIS_CONNECT_TIMEOUT_SECONDS: '2',
      })!,
      { logger: createLogger({ level: 'silent' }), nodeEnv: 'test' },
    );
    if (!connected.ok) throw new Error(connected.message);
    const index = started++;
    const ts = await startTestServer({
      now: Date.now,
      redisTimings: FAST_TIMINGS,
      ...rest,
      ...perNode?.(index),
      tokenSecrets: secrets,
      redisPrefix: prefix,
      redisLink: connected.link,
    });
    const node = { ts, proxy, link: connected.link };
    nodes.push(node);
    return node;
  }

  for (let i = 0; i < size; i++) await add();

  return {
    prefix,
    secrets,
    nodes,
    add,
    async stop(node) {
      nodes.splice(nodes.indexOf(node), 1);
      // The server closes its sockets with 1001 itself (no disconnect rules).
      await node.ts.server.close();
      await node.proxy.close();
    },
    async close() {
      for (const node of nodes.splice(0)) {
        node.proxy.restore();
        await node.ts.close();
        await node.proxy.close();
      }
    },
  };
}
