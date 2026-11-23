import { randomBytes } from 'node:crypto';
import type { WebSocketConstructorLike } from '@mosherw/sync-system-client';
import { AppRegistry } from '@mosherw/sync-system-server/src/apps/app-registry.js';
import { parseAppsConfig } from '@mosherw/sync-system-server/src/config/apps-config.js';
import { parseEnv } from '@mosherw/sync-system-server/src/config/env.js';
import { createLogger } from '@mosherw/sync-system-server/src/logging/logger.js';
import { type SyncServer, createSyncServer } from '@mosherw/sync-system-server/src/server.js';
import { WebSocket as WsWebSocket } from 'ws';

/** An obvious test key (32+ characters, as the server requires). Never a real key (R14). */
export const TEST_KEY = 'test-key-react-int-0123456789-abcdef';

export interface RealServer {
  readonly url: string;
  close(): Promise<void>;
}

/** Discards the server's log lines. */
const sink = { write: (_chunk: string): void => undefined };

/**
 * The real sync server in-process on 127.0.0.1, minimal version of the
 * client's helper (section 4): one test app with a short handoff grace.
 */
export async function startRealServer(
  app: Record<string, unknown> = {},
): Promise<RealServer & { server: SyncServer }> {
  const env = parseEnv({ LOG_LEVEL: 'warn' });
  const apps = [{ namespace: 'app-react', apiKey: TEST_KEY, minAppVersion: '1.0.0', ...app }];
  const registry = new AppRegistry(parseAppsConfig(JSON.stringify({ apps }), env));
  const server = createSyncServer({
    env,
    registry,
    logger: createLogger({ level: env.logLevel, destination: sink }),
    tokenSecrets: { current: randomBytes(32), source: 'random' },
  });
  const port = await server.listen(0, '127.0.0.1');
  return { server, url: `ws://127.0.0.1:${port}/ws`, close: () => server.close() };
}

/** `ws` with a 1 MiB frame limit, as the client README recommends for Node. */
export class TestWs extends WsWebSocket {
  constructor(url: string) {
    super(url, { maxPayload: 1024 * 1024 });
  }
}

export const TestWebSocket: WebSocketConstructorLike = TestWs;
