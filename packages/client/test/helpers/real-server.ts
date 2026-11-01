import { AppRegistry } from '@sync-system/server/src/apps/app-registry.js';
import { parseAppsConfig } from '@sync-system/server/src/config/apps-config.js';
import { parseEnv } from '@sync-system/server/src/config/env.js';
import { createLogger } from '@sync-system/server/src/logging/logger.js';
import { type SyncServer, createSyncServer } from '@sync-system/server/src/server.js';
import { WebSocket as WsWebSocket } from 'ws';
import type { WebSocketConstructorLike } from '../../src/host.js';

/** Obvious test keys (32+ characters, as the server requires). Never real keys. */
export const KEY_A = 'test-key-client-int-a-0123456789-abcdef';
export const KEY_B = 'test-key-client-int-b-0123456789-abcdef';

export interface TestApp {
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

export interface RealServerOptions {
  apps?: TestApp[];
  /** Env variables as the process would see them. */
  env?: Record<string, string>;
  /** Fixed port, for restart tests. Default: a random free port. */
  port?: number;
}

export interface RealServer {
  server: SyncServer;
  port: number;
  url: string;
  /** Everything the server logged (JSON lines). */
  logs: string[];
  close(): Promise<void>;
}

/** Collects pino output in memory. */
class LogSink {
  readonly lines: string[] = [];
  write(chunk: string): void {
    for (const line of chunk.split('\n')) if (line.length > 0) this.lines.push(line);
  }
}

async function listenWithRetry(server: SyncServer, port: number): Promise<number> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await server.listen(port, '127.0.0.1');
    } catch (error) {
      // A port just released can still be in use on some hosts.
      if (attempt >= 20 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/** Starts the real sync server in-process on 127.0.0.1. */
export async function startRealServer(options: RealServerOptions = {}): Promise<RealServer> {
  const env = parseEnv({ LOG_LEVEL: 'info', ...options.env });
  const apps = (options.apps ?? [{ namespace: 'app-a', apiKey: KEY_A }]).map((app) => ({
    minAppVersion: '1.0.0',
    ...app,
  }));
  const registry = new AppRegistry(parseAppsConfig(JSON.stringify({ apps }), env));
  const sink = new LogSink();
  const logger = createLogger({ level: env.logLevel, destination: sink });
  const server = createSyncServer({ env, registry, logger });
  const port = await listenWithRetry(server, options.port ?? 0);
  return {
    server,
    port,
    url: `ws://127.0.0.1:${port}/ws`,
    logs: sink.lines,
    close: () => server.close(),
  };
}

/**
 * `ws` with a 1 MiB frame limit, as the README recommends for Node (L7).
 * Counts every socket it constructs.
 */
export function countingWs(): { Ws: WebSocketConstructorLike; sockets: () => number } {
  let sockets = 0;
  class CountingWs extends WsWebSocket {
    constructor(url: string) {
      super(url, { maxPayload: 1024 * 1024 });
      sockets += 1;
    }
  }
  return { Ws: CountingWs, sockets: () => sockets };
}
