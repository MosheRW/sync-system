import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CloseCode } from '@sync-system/protocol';
import { type ServerOptions, WebSocketServer } from 'ws';
import type { AppRegistry } from './apps/app-registry.js';
import { EndedGroups } from './groups/ended-groups.js';
import { GroupService } from './groups/group-service.js';
import type { GroupStore } from './groups/group-store.js';
import { InMemoryGroupStore } from './groups/in-memory-group-store.js';
import { LocalNotifier } from './groups/notifier.js';
import type { ServerEnv } from './config/env.js';
import { ConfigError } from './config/config-error.js';
import { MIN_TOKEN_SECRET_BYTES, type TokenSecrets } from './config/token-secret.js';
import { handleHttpRequest } from './http/health.js';
import {
  CLOSE_TIMEOUT_MS,
  ENDED_SWEEP_MS,
  HANDSHAKE_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  HTTP_CONNECTION_MARGIN,
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
  maxQueuedInboundBytes,
  transportMaxPayload,
} from './limits/constants.js';
import { SlidingWindowRateLimiter } from './limits/rate-limiter.js';
import { type Scheduler, realScheduler } from './time/scheduler.js';
import { CodesBlobService } from './tokens/codes-blob.js';
import { QrTicketService } from './tokens/qr-tickets.js';
import {
  CODES_BLOB_INFO_PREFIX,
  QR_TICKET_INFO_PREFIX,
  TokenKeyring,
} from './tokens/token-keys.js';
import { TokenService } from './tokens/token-service.js';
import type { Logger } from './logging/logger.js';
import type { RandomInt } from './joins/codes.js';
import { Connection } from './ws/connection.js';
import { ConnectionCounter, type ConnectionStats } from './ws/connection-counter.js';
import { Heartbeat } from './ws/heartbeat.js';
import { createUpgradeHandler } from './ws/upgrade.js';

export interface SyncServerOptions {
  env: ServerEnv;
  registry: AppRegistry;
  logger: Logger;
  /** Clock in ms; injected by tests. Ignored when `scheduler` is given. */
  now?: () => number;
  /**
   * Clock and timers for group timers; injected by tests (a manual
   * scheduler). Defaults to real, unref()ed timers on `now`.
   */
  scheduler?: Scheduler;
  /** Defaults to a new InMemoryGroupStore. */
  store?: GroupStore;
  /** Defaults to HEARTBEAT_INTERVAL_MS; shortened by tests. */
  heartbeatMs?: number;
  /** Defaults to HANDSHAKE_TIMEOUT_MS; shortened by tests. */
  handshakeTimeoutMs?: number;
  /**
   * Token signing secrets from `parseTokenSecrets()` (required, #7 L1).
   * There is no fallback: a missing or malformed value refuses to start.
   */
  tokenSecrets: TokenSecrets;
  /**
   * Integer source for join code draws (#10). Defaults to `crypto.randomInt`;
   * tests inject one to force code collisions.
   */
  codeRandom?: RandomInt;
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

const TOKEN_SECRETS_REQUIRED =
  'tokenSecrets is required: pass the secrets from parseTokenSecrets()';

function isSecretBuffer(value: unknown): boolean {
  return Buffer.isBuffer(value) && value.length >= MIN_TOKEN_SECRET_BYTES;
}

/**
 * Runtime check for untyped callers (#7 L1, R1): `current` and, when set,
 * `previous` must be Buffers of at least 32 bytes. The message names the
 * field only, never a value.
 */
function assertTokenSecrets(value: unknown): asserts value is TokenSecrets {
  if (typeof value !== 'object' || value === null) throw new ConfigError(TOKEN_SECRETS_REQUIRED);
  const { current, previous } = value as { current?: unknown; previous?: unknown };
  if (!isSecretBuffer(current)) {
    throw new ConfigError(
      `${TOKEN_SECRETS_REQUIRED} (tokenSecrets.current must be a Buffer of at least ${MIN_TOKEN_SECRET_BYTES} bytes)`,
    );
  }
  if (previous !== undefined && !isSecretBuffer(previous)) {
    throw new ConfigError(
      `${TOKEN_SECRETS_REQUIRED} (tokenSecrets.previous must be a Buffer of at least ${MIN_TOKEN_SECRET_BYTES} bytes)`,
    );
  }
}

export function createSyncServer(options: SyncServerOptions): SyncServer {
  // Before anything is created, so a bad config binds no socket (R1).
  const tokenSecrets: unknown = options.tokenSecrets;
  assertTokenSecrets(tokenSecrets);
  const { env, logger, registry } = options;
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  const scheduler = options.scheduler ?? realScheduler(options.now ?? Date.now);
  const now = (): number => scheduler.now();

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

  // closeTimeout is a ws option that @types/ws does not declare yet.
  const wssOptions: ServerOptions & { closeTimeout: number } = {
    noServer: true,
    maxPayload: transportMaxPayload(env.maxMessageSizeCeiling),
    // Compression adds zip-bomb and memory risk (L4).
    perMessageDeflate: false,
    clientTracking: false,
    // Pings are answered by Connection, which charges them to the inbound
    // limit and checks the outbound buffer first (H2, H3).
    autoPong: false,
    // A peer that never answers our close frame is dropped after this, so it
    // cannot hold a pending, global or per-app slot for ws's 30 s default (S1).
    closeTimeout: CLOSE_TIMEOUT_MS,
  };
  const wss = new WebSocketServer(wssOptions);
  wss.on('error', (err: NodeJS.ErrnoException) => {
    logger.error({ event: 'wss_error', code: err.code, name: err.name }, 'websocket server error');
  });

  const store = options.store ?? new InMemoryGroupStore();
  const ended = new EndedGroups(now, logger);
  let sweepTimer: NodeJS.Timeout | undefined;
  const tokens = new TokenService(new TokenKeyring(tokenSecrets));
  // One keyring per purpose, so the keys can never be mixed up (#10 R4).
  const qrTickets = new QrTicketService(
    new TokenKeyring(tokenSecrets, QR_TICKET_INFO_PREFIX),
    env.qrTicketSecondsCeiling,
  );
  const codesBlobs = new CodesBlobService(new TokenKeyring(tokenSecrets, CODES_BLOB_INFO_PREFIX));
  const groups = new GroupService({
    store,
    notifier: new LocalNotifier(),
    logger,
    rateLimiter: new SlidingWindowRateLimiter(now),
    tokens,
    scheduler,
    refresh: {
      activities: env.tokenRefreshActivities,
      minMs: env.tokenRefreshMinSeconds * 1000,
      maxMs: env.tokenRefreshMaxSeconds * 1000,
    },
    ended,
    qrTickets,
    codesBlobs,
    ...(options.codeRandom === undefined ? {} : { codeRandom: options.codeRandom }),
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
          maxQueuedBytes: maxQueuedInboundBytes(env.maxMessageSizeCeiling),
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
          sweepTimer = setInterval(() => ended.sweep(), ENDED_SWEEP_MS);
          sweepTimer.unref();
          resolve(port);
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(listenPort, host);
      });
    },
    async close() {
      heartbeat.stop();
      clearInterval(sweepTimer);
      groups.close();
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
      // Disconnect handling may have armed timers while sockets closed.
      groups.close();
    },
  };
}
