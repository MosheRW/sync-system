import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CloseCode } from '@sync-system/protocol';
import { WebSocketServer } from 'ws';
import type { AppRegistry } from './apps/app-registry.js';
import { GroupService } from './groups/group-service.js';
import type { GroupStore } from './groups/group-store.js';
import { InMemoryGroupStore } from './groups/in-memory-group-store.js';
import { LocalNotifier } from './groups/notifier.js';
import type { ServerEnv } from './config/env.js';
import { handleHttpRequest } from './http/health.js';
import {
  HANDSHAKE_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HTTP_CONNECTION_MARGIN,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  transportMaxPayload,
} from './limits/constants.js';
import { SlidingWindowRateLimiter } from './limits/rate-limiter.js';
import type { Logger } from './logging/logger.js';
import { Connection } from './ws/connection.js';
import { ConnectionCounter, type ConnectionStats } from './ws/connection-counter.js';
import { Heartbeat } from './ws/heartbeat.js';
import { createUpgradeHandler } from './ws/upgrade.js';

export interface SyncServerOptions {
  env: ServerEnv;
  registry: AppRegistry;
  logger: Logger;
  /** Clock in ms; injected by tests. */
  now?: () => number;
  /** Defaults to a new InMemoryGroupStore. */
  store?: GroupStore;
  /** Defaults to HEARTBEAT_INTERVAL_MS; shortened by tests. */
  heartbeatMs?: number;
  /** Defaults to HANDSHAKE_TIMEOUT_MS; shortened by tests. */
  handshakeTimeoutMs?: number;
}

export interface SyncServer {
  /** Starts listening; resolves with the bound port. */
  listen(port: number, host: string): Promise<number>;
  /** Stops accepting, closes every socket, and resolves when done. */
  close(): Promise<void>;
  /** Bound port (0 before listen). */
  readonly port: number;
  /** The underlying HTTP server (tests inspect its timeouts). */
  readonly httpServer: Server;
  /** Connection counts. For tests only; never exposed over HTTP. */
  stats(): ConnectionStats;
}

/** How long close() waits for clients to complete the close handshake. */
const SHUTDOWN_GRACE_MS = 1_000;

export function createSyncServer(options: SyncServerOptions): SyncServer {
  const { env, logger, registry } = options;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  const httpServer = createServer(handleHttpRequest);
  // Slowloris protection and a hard socket backstop above the WS cap (H1).
  httpServer.headersTimeout = HTTP_HEADERS_TIMEOUT_MS;
  httpServer.requestTimeout = HTTP_REQUEST_TIMEOUT_MS;
  httpServer.maxConnections = env.maxConnections + HTTP_CONNECTION_MARGIN;

  // Error guards (H4): a malformed request or a server error never crashes.
  httpServer.on('clientError', (_err, socket) => {
    socket.destroy();
  });
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    logger.error({ event: 'http_error', code: err.code, name: err.name }, 'http server error');
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: transportMaxPayload(env.maxMessageSizeCeiling),
    // Compression adds zip-bomb and memory risk (L4).
    perMessageDeflate: false,
    clientTracking: false,
  });
  wss.on('error', (err: NodeJS.ErrnoException) => {
    logger.error({ event: 'wss_error', code: err.code, name: err.name }, 'websocket server error');
  });

  const store = options.store ?? new InMemoryGroupStore();
  const groups = new GroupService({
    store,
    notifier: new LocalNotifier(),
    logger,
    now,
    rateLimiter: new SlidingWindowRateLimiter(now),
  });
  const counter = new ConnectionCounter();
  const connections = new Set<Connection>();

  httpServer.on(
    'upgrade',
    createUpgradeHandler({
      wss,
      counter,
      env,
      logger,
      onConnection(ws) {
        const connection = new Connection(ws, {
          logger,
          counter,
          registry,
          groups,
          handshakeTimeoutMs,
          inbound: { ratePerSecond: env.maxInboundMessagesPerSecond, burst: env.maxInboundBurst },
          now,
          maxBufferedBytes: env.maxBufferedBytes,
          onClosed: (closed) => connections.delete(closed),
        });
        connections.add(connection);
      },
    }),
  );

  const heartbeat = new Heartbeat(
    options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS,
    () => connections,
    (result) => {
      logger.info({ event: 'heartbeat_terminated', cause: result }, 'heartbeat terminated socket');
    },
  );

  let port = 0;

  async function closeConnections(): Promise<void> {
    const open = [...connections];
    if (open.length === 0) return;
    const allClosed = Promise.all(
      open.map(
        (connection) =>
          new Promise<void>((resolve) => {
            if (connection.isClosed) {
              resolve();
              return;
            }
            connection.ws.once('close', () => resolve());
            connection.ws.close(CloseCode.GOING_AWAY, 'server shutting down');
          }),
      ),
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
    });
    await Promise.race([allClosed, timeout]);
    clearTimeout(timer);
    for (const connection of connections) connection.ws.terminate();
  }

  return {
    get port() {
      return port;
    },
    httpServer,
    stats: () => counter.snapshot(),
    listen(listenPort, host) {
      return new Promise((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          port = (httpServer.address() as AddressInfo).port;
          heartbeat.start();
          resolve(port);
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(listenPort, host);
      });
    },
    async close() {
      heartbeat.stop();
      const httpClosed = new Promise<void>((resolve) => {
        if (!httpServer.listening) {
          resolve();
          return;
        }
        httpServer.close(() => resolve());
      });
      httpServer.closeIdleConnections();
      await closeConnections();
      httpServer.closeAllConnections();
      await httpClosed;
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
