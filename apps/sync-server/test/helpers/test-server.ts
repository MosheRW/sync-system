import { AppRegistry } from '../../src/apps/app-registry.js';
import { parseAppsConfig } from '../../src/config/apps-config.js';
import { parseEnv } from '../../src/config/env.js';
import type { LogLevel } from '../../src/config/env.js';
import { createLogger } from '../../src/logging/logger.js';
import { type SyncServer, type SyncServerOptions, createSyncServer } from '../../src/server.js';
import { LogCapture } from './log-capture.js';
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
}

export const DEFAULT_TEST_APPS: TestAppInput[] = [
  { namespace: 'app-a', apiKey: KEY_A },
  { namespace: 'app-b', apiKey: KEY_B },
];

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
  const { env: envOverrides, apps, logLevel, ...rest } = options;
  const env = parseEnv({ LOG_LEVEL: logLevel ?? 'trace', ...envOverrides });
  const appInputs = (apps ?? DEFAULT_TEST_APPS).map((app) => ({ minAppVersion: '1.0.0', ...app }));
  const registry = new AppRegistry(parseAppsConfig(JSON.stringify({ apps: appInputs }), env));
  const logs = new LogCapture();
  const logger = createLogger({ level: env.logLevel, destination: logs });
  const server = createSyncServer({ env, registry, logger, ...rest });
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
