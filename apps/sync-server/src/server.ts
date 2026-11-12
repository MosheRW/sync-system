import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CloseCode } from '@sync-system/protocol';
import { type ServerOptions, WebSocketServer } from 'ws';
import type { AppRegistry } from './apps/app-registry.js';
import { GroupService } from './groups/group-service.js';
import type { GroupStore } from './groups/group-store.js';
import { LocalNotifier } from './groups/notifier.js';
import { ClusterNotifier } from './groups/cluster-notifier.js';
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
import { type Logger, safeErr } from './logging/logger.js';
import type { RandomInt } from './joins/codes.js';
import { Connection } from './ws/connection.js';
import { ConnectionCounter, type ConnectionStats } from './ws/connection-counter.js';
import { Heartbeat } from './ws/heartbeat.js';
import { createUpgradeHandler } from './ws/upgrade.js';
import { type Storage, type StorageStatus, memoryStorage } from './storage/storage.js';
import { StorageStartError } from './storage/errors.js';

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
  /**
   * Where groups live (#35). Defaults to the in-memory storage; `store`
   * replaces only its group store (tests).
   */
  storage?: Storage;
  /** Defaults to a new InMemoryGroupStore. Ignored when `storage` is given. */
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
  /** Cap of the ended-groups memory; defaults to MAX_ENDED_GROUPS. Tests lower it. */
  endedGroupsCap?: number;
  /** Groups waiting for a disconnect replay; defaults to MAX_CONNECTIONS. Tests lower it. */
  replayCap?: number;
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
  /**
   * Which storage serves groups and, for Redis, whether it is reachable
   * (#35 AC27). Not exposed over HTTP in 9a.
   */
  storage(): StorageStatus;
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
    logger.error({ event: 'http_error', err: safeErr(err) }, 'http server error');
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
    logger.error({ event: 'wss_error', err: safeErr(err) }, 'websocket server error');
  });

  const storage =
    options.storage ??
    memoryStorage({
      scheduler,
      logger,
      ...(options.store === undefined ? {} : { groups: options.store }),
      ...(options.endedGroupsCap === undefined ? {} : { endedGroupsCap: options.endedGroupsCap }),
    });
  const appsByNamespace = new Map(registry.apps().map((app) => [app.namespace, app]));
  let sweepTimer: NodeJS.Timeout | undefined;
  // Read once, before any token is issued (#13 6.9 layer 2, RC18).
  const processStartedAt = scheduler.now();
  const tokens = new TokenService(new TokenKeyring(tokenSecrets), processStartedAt);
  // The iat floor follows the store's epoch (#35 architecture 4.5).
  storage.epoch?.follow((epoch) => tokens.raiseIatFloor(epoch));
  // One keyring per purpose, so the keys can never be mixed up (#10 R4).
  const qrTickets = new QrTicketService(
    new TokenKeyring(tokenSecrets, QR_TICKET_INFO_PREFIX),
    env.qrTicketSecondsCeiling,
  );
  const codesBlobs = new CodesBlobService(new TokenKeyring(tokenSecrets, CODES_BLOB_INFO_PREFIX));
  const notifier = new LocalNotifier();
  const groups = new GroupService({
    store: storage.groups,
    ...(storage.epoch === undefined ? {} : { epoch: storage.epoch }),
    keepAttachmentsOnClose: storage.keepAttachmentsOnClose,
    replayCap: options.replayCap ?? env.maxConnections,
    codes: storage.codes,
    doors: storage.doors,
    timerBackend: storage.timers,
    work: storage.work,
    ...(storage.leases === undefined ? {} : { leases: storage.leases }),
    ...(storage.cluster === undefined ? {} : { fenced: () => storage.cluster!.fenced() }),
    notifier,
    ...(storage.cluster === undefined
      ? {}
      : { cluster: new ClusterNotifier(notifier, storage.cluster.host) }),
    logger,
    rateLimiter: new SlidingWindowRateLimiter(now),
    tokens,
    scheduler,
    refresh: {
      activities: env.tokenRefreshActivities,
      minMs: env.tokenRefreshMinSeconds * 1000,
      maxMs: env.tokenRefreshMaxSeconds * 1000,
    },
    ended: storage.ended,
    processStartedAt,
    appOf: (namespace) => appsByNamespace.get(namespace),
    qrTickets,
    codesBlobs,
    ...(options.codeRandom === undefined ? {} : { codeRandom: options.codeRandom }),
  });
  // Redis back after an outage: queued disconnects, then due timers (#35 8).
  storage.onRecovered(() => groups.replayDisconnects());
  const counter = new ConnectionCounter();
  const connections = new Set<Connection>();
  // A self-fence (#35 architecture 12.5): every session in a group, parked
  // or pending closes with 1001, with no disconnect rule (security C13).
  // Effects other instances published for this one (#35 architecture 12.7).
  storage.cluster?.setReceiver({ receive: (effects) => groups.receiveRemote(effects) });
  // Effects may have been lost: sessions resume and read the current state.
  storage.cluster?.onResync(() => {
    let closed = 0;
    for (const connection of connections) {
      const session = connection.session;
      if (session === undefined) continue;
      if (session.membership === undefined && session.parked === undefined) {
        if (session.pendingJoin === undefined) continue;
      }
      closed += 1;
      connection.ws.close(CloseCode.GOING_AWAY, 'temporarily unavailable');
    }
    logger.warn({ event: 'pubsub_resync', sessions: closed }, 'sessions closed to resync');
  });
  storage.cluster?.onFence(() => {
    let closed = 0;
    for (const connection of connections) {
      const session = connection.session;
      if (session === undefined || !groups.quietDetach(session)) continue;
      closed += 1;
      connection.ws.close(CloseCode.GOING_AWAY, 'temporarily unavailable');
    }
    groups.onFenced();
    logger.info({ event: 'fence_closed', sessions: closed }, 'sessions closed after a fence');
  });

  httpServer.on(
    'upgrade',
    createUpgradeHandler({
      wss,
      counter,
      env,
      logger,
      available: () => {
        const status = storage.status();
        return status.kind === 'memory' || status.state === 'connected';
      },
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
    storage: () => storage.status(),
    async listen(listenPort, host) {
      try {
        await storage.start((namespace, groupId, restart) =>
          groups.sweepGroup(namespace, groupId, restart),
        );
      } catch (err) {
        throw new StorageStartError(err);
      }
      return new Promise((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off('error', onError);
          port = (httpServer.address() as AddressInfo).port;
          heartbeat.start();
          sweepTimer = setInterval(() => {
            storage.ended.sweep().catch((err: unknown) => {
              logger.warn({ event: 'ended_sweep_failed', err: safeErr(err) }, 'ended sweep failed');
            });
          }, ENDED_SWEEP_MS);
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
      await storage.close();
    },
  };
}
