import { createHash } from 'node:crypto';
import type * as RedisModule from '@redis/client';
import semver from 'semver';
import type { RedisSettings } from '../../config/redis.js';
import {
  REDIS_ERROR_LOG_INTERVAL_MS,
  REDIS_PROBE_INTERVAL_MS,
  REDIS_RECONNECT_MAX_MS,
} from '../../limits/constants.js';
import { type Logger, safeErr } from '../../logging/logger.js';
import { STORAGE_START_MESSAGES, StorageReplyError, StorageUnavailableError } from '../errors.js';

/** The client module, loaded only when REDIS_URL is set (#35 ADR 0010, AC28). */
type ClientModule = typeof RedisModule;

/** The oldest supported server (ADR 0010). Valkey reports the Redis version it is compatible with. */
export const MIN_REDIS_VERSION = '7.2.0';

/** A constant Lua script, run with EVALSHA (security C6: every dynamic value via KEYS/ARGV). */
export class LuaScript {
  readonly sha: string;
  constructor(readonly source: string) {
    this.sha = createHash('sha1').update(source, 'utf8').digest('hex');
  }
}

export type RedisState = 'connected' | 'unreachable';

/**
 * The one Redis connection of the process (#35 architecture 3, 8). Every
 * command goes through `send` or `script`, which apply the command timeout
 * and turn failures into StorageUnavailableError (connection, timeout,
 * transient replies: the state becomes `unreachable` until a PING succeeds)
 * or StorageReplyError (anything else, security C8).
 */
/**
 * A subscriber connection (#35 architecture 12.7): a duplicate of the
 * command link with the same endpoint, TLS, timeouts and redaction
 * (security C9, C10), its own `error` listener, subscribed to one channel.
 */
export interface SubscriberLink {
  subscribe(channel: string, listener: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
  /** PING within the command timeout (security C15: stall detection). */
  probe(): Promise<boolean>;
  /** `down` when the connection drops, `up` when it is ready again. */
  onState(listener: (state: 'down' | 'up') => void): void;
  close(): Promise<void>;
}

export interface RedisLink {
  send(args: readonly string[]): Promise<unknown>;
  script(script: LuaScript, keys: readonly string[], args: readonly string[]): Promise<unknown>;
  readonly state: RedisState;
  /** Called on every state change (`connected` after a successful probe). */
  onState(listener: (state: RedisState) => void): void;
  close(): Promise<void>;
  /** Opens a subscriber connection to the same Redis (several instances). */
  openSubscriber?(): Promise<SubscriberLink>;
}

export type ConnectResult = { ok: true; link: RedisLink } | { ok: false; message: string };

export interface ConnectDeps {
  logger: Logger;
  nodeEnv: string | undefined;
  /** Tests stub the client module (INFO replies) or count its loads. */
  importClient?: () => Promise<ClientModule>;
}

/** Replies that mean "try again later", not "this request is wrong" (security C4, C8). */
const TRANSIENT_REPLIES = new Set(['LOADING', 'READONLY', 'MASTERDOWN', 'BUSY', 'OOM', 'TRYAGAIN']);
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
const AUTH_REPLIES = new Set(['WRONGPASS', 'NOAUTH', 'NOPERM']);
const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'EPROTO',
]);
const CONNECTION_ERROR_NAMES = new Set([
  'ConnectionTimeoutError',
  'SocketTimeoutError',
  'TimeoutError',
  'ClientClosedError',
  'ClientOfflineError',
  'DisconnectsClientError',
  'SocketClosedUnexpectedlyError',
  'ReconnectStrategyError',
  'AbortError',
  'CommandTimeout',
  'StartupTimeout',
]);

/**
 * The class of a client error. The client's error classes do not all set
 * `name`, so the constructor name is used.
 */
function errorClass(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const ctor = (err as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof ctor === 'string' && ctor !== 'Error' ? ctor : err.name;
}

const REPLY_CLASSES = new Set(['ErrorReply', 'SimpleError', 'BlobError', 'MultiErrorReply']);

/** The first word of a Redis error reply (`WRONGPASS`, `OOM`, ...), or undefined. */
export function replyCode(err: unknown): string | undefined {
  if (!(err instanceof Error) || !REPLY_CLASSES.has(errorClass(err) ?? '')) return undefined;
  const word = /^[A-Z][A-Z_-]*/.exec(err.message);
  return word?.[0] ?? 'ERR';
}

function errnoCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Whether `err` means Redis is unreachable or temporarily unable to serve (security C8). */
export function isUnavailable(err: unknown): boolean {
  if (err instanceof StorageUnavailableError) return true;
  const reply = replyCode(err);
  if (reply !== undefined) return TRANSIENT_REPLIES.has(reply);
  if (CONNECTION_ERROR_NAMES.has(errorClass(err) ?? '')) return true;
  return /^E[A-Z]+$/.test(errnoCode(err) ?? '');
}

/**
 * The fixed `Startup error` texts of a failed Redis connection (#35 AC4;
 * listed in docs/startup-errors.md, #36 AC40). No host, port, user or
 * password.
 */
export const STARTUP_MESSAGES = {
  authentication: STORAGE_START_MESSAGES.authentication,
  tls: 'Redis TLS handshake failed (REDIS_URL)',
  unreachable: 'Redis is unreachable (REDIS_URL)',
  failed: STORAGE_START_MESSAGES.failed,
  tooOld: 'Redis 7.2 or later is required',
} as const;

/**
 * The `Startup error` text for a failed connection (#35 AC4), from the
 * error code only: never the message, host, port, user or password.
 */
export function startupMessage(err: unknown): string {
  const reply = replyCode(err);
  if (reply !== undefined && AUTH_REPLIES.has(reply)) {
    return STARTUP_MESSAGES.authentication;
  }
  const code = errnoCode(err) ?? '';
  if (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') || TLS_CODES.has(code)) {
    return STARTUP_MESSAGES.tls;
  }
  if (code.startsWith('CERT_')) return STARTUP_MESSAGES.tls;
  if (
    UNREACHABLE_CODES.has(code) ||
    errorClass(err) === 'ConnectionTimeoutError' ||
    errorClass(err) === 'TimeoutError' ||
    errorClass(err) === 'StartupTimeout'
  ) {
    return STARTUP_MESSAGES.unreachable;
  }
  return STARTUP_MESSAGES.failed;
}

/** One `field:value` of an INFO section, or undefined. */
export function infoField(info: string, field: string): string | undefined {
  for (const line of info.split(/\r?\n/)) {
    if (line.startsWith(`${field}:`)) return line.slice(field.length + 1).trim();
  }
  return undefined;
}

class StartupTimeout extends Error {
  constructor() {
    super('startup timeout');
    this.name = 'TimeoutError';
  }
}

/** Reconnect delay: `min(2^n * 100 ms, 5 s)` with up to 20 % jitter (architecture 3). */
export function reconnectDelay(retries: number, random: () => number = Math.random): number {
  const base = Math.min(2 ** Math.min(retries, 16) * 100, REDIS_RECONNECT_MAX_MS);
  return Math.round(base * (0.8 + 0.2 * random()));
}

/**
 * Connects to Redis with the startup checks of #35 architecture 3: a
 * bounded connect, the server version (7.2 or later), the eviction policy
 * (warning) and a missing password in production (warning). Returns the
 * `Startup error` text on failure, never a value from REDIS_URL.
 */
export async function connectRedis(
  settings: RedisSettings,
  deps: ConnectDeps,
): Promise<ConnectResult> {
  const { logger } = deps;
  const { createClient } = await (deps.importClient ?? (() => import('@redis/client')))();
  const endpoint = settings.endpoint();
  let starting = true;
  let lastErrorLogAt = Number.NEGATIVE_INFINITY;
  const make = (): Client => {
    const client = createClient({
      socket: {
        host: endpoint.host,
        port: endpoint.port,
        connectTimeout: settings.connectTimeoutMs,
        // Verification always on (security C10): no option turns it off.
        ...(endpoint.tls ? { tls: true as const, servername: endpoint.host } : {}),
        // At startup a failure is final (AC4); later, back off and retry.
        reconnectStrategy: (retries: number) => (starting ? false : reconnectDelay(retries)),
      },
      ...(endpoint.username === undefined ? {} : { username: endpoint.username }),
      ...(endpoint.password === undefined ? {} : { password: endpoint.password }),
      database: endpoint.database,
      // Fail fast while disconnected; never queue work (ADR 0014).
      disableOfflineQueue: true,
      disableClientInfo: true,
      // Plain RESP2 replies: strings, integers, arrays.
      RESP: 2,
    });
    client.on('error', (err: unknown) => {
      const now = Date.now();
      if (starting || now - lastErrorLogAt < REDIS_ERROR_LOG_INTERVAL_MS) return;
      lastErrorLogAt = now;
      logger.warn({ event: 'redis_error', err: safeErr(err) }, 'redis connection error');
    });
    return client;
  };
  const client = make();

  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new StartupTimeout()), settings.connectTimeoutMs);
  });
  try {
    await Promise.race([client.connect(), deadline]);
  } catch (err) {
    clearTimeout(timer);
    client.destroy();
    return { ok: false, message: startupMessage(err) };
  }
  clearTimeout(timer);

  const link = new ClientLink(
    client,
    make,
    settings.commandTimeoutMs,
    settings.connectTimeoutMs,
    logger,
  );
  try {
    const server = String(await link.send(['INFO', 'server']));
    const version = semver.coerce(infoField(server, 'redis_version') ?? '');
    if (version === null || semver.lt(version, MIN_REDIS_VERSION)) {
      await link.close();
      return { ok: false, message: STARTUP_MESSAGES.tooOld };
    }
    const memory = String(await link.send(['INFO', 'memory']));
    const policy = infoField(memory, 'maxmemory_policy');
    if (policy !== 'noeviction') {
      // Security C2: eviction can drop live groups and ended entries.
      logger.warn(
        { event: 'redis_eviction_policy', policy: policy ?? 'unknown' },
        'redis maxmemory-policy is not noeviction: redis may evict live groups, and an ended group may then be recreated from an old token; set maxmemory-policy noeviction',
      );
    }
  } catch (err) {
    await link.close();
    return {
      ok: false,
      message: replyCode(err) === 'NOPERM' ? startupMessage(err) : STARTUP_MESSAGES.failed,
    };
  }
  if (deps.nodeEnv === 'production' && !settings.hasPassword) {
    logger.warn({ event: 'redis_no_password' }, 'REDIS_URL has no password');
  }
  starting = false;
  link.watch();
  logger.info({ event: 'redis_connected' }, 'redis connected');
  return { ok: true, link };
}

/** The part of the client the link uses. */
interface Client {
  sendCommand(args: string[], options?: { timeout?: number }): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  connect(): Promise<unknown>;
  readonly isOpen: boolean;
  close(): Promise<unknown>;
  destroy(): void;
  subscribe?(channel: string, listener: (message: unknown) => void): Promise<unknown>;
  unsubscribe?(channel: string): Promise<unknown>;
}

/** Resolves `work`, or rejects with a timeout after `ms`. */
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new StorageUnavailableError()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The subscriber connection over the client module (#35 architecture 12.7). */
class ClientSubscriber implements SubscriberLink {
  private readonly listeners: Array<(state: 'down' | 'up') => void> = [];
  private closed = false;

  constructor(
    private readonly client: Client,
    private readonly timeoutMs: number,
  ) {
    const emit = (state: 'down' | 'up') => {
      if (this.closed) return;
      for (const listener of this.listeners) listener(state);
    };
    client.on('end', () => emit('down'));
    client.on('reconnecting', () => emit('down'));
    client.on('ready', () => emit('up'));
  }

  onState(listener: (state: 'down' | 'up') => void): void {
    this.listeners.push(listener);
  }

  async subscribe(channel: string, listener: (message: string) => void): Promise<void> {
    await bounded(
      this.client.subscribe!(channel, (message) => listener(String(message))),
      this.timeoutMs,
    );
  }

  async unsubscribe(channel: string): Promise<void> {
    await bounded(this.client.unsubscribe!(channel), this.timeoutMs);
  }

  async probe(): Promise<boolean> {
    try {
      const reply = await bounded(this.client.sendCommand(['PING']), this.timeoutMs);
      return String(reply).toLowerCase() === 'pong';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      if (this.client.isOpen) await bounded(this.client.close(), this.timeoutMs);
    } catch {
      // Destroyed below.
    } finally {
      this.client.destroy();
    }
  }
}

/** A command not answered within the command timeout (#35 AC26). */
class CommandTimeout extends Error {
  constructor() {
    super('command timeout');
    this.name = 'TimeoutError';
  }
}

/** The connection with timeouts, error classes and the state machine (ADR 0014, security C4). */
class ClientLink implements RedisLink {
  private current: RedisState = 'connected';
  private readonly listeners: Array<(state: RedisState) => void> = [];
  private probeTimer: NodeJS.Timeout | undefined;
  private probing = false;
  private closed = false;
  /** When the current client was started, until it is ready. */
  private startedAt: number | undefined;

  constructor(
    private client: Client,
    private readonly make: () => Client,
    private readonly timeoutMs: number,
    private readonly connectTimeoutMs: number,
    private readonly logger: Logger,
  ) {}

  get state(): RedisState {
    return this.current;
  }

  /**
   * A subscriber connection made like the command connection (same
   * endpoint, TLS, credentials, rate-limited `safeErr` error logging).
   */
  async openSubscriber(): Promise<SubscriberLink> {
    const client = this.make();
    try {
      await bounded(client.connect(), this.connectTimeoutMs);
    } catch {
      client.destroy();
      throw new StorageUnavailableError();
    }
    return new ClientSubscriber(client, this.timeoutMs);
  }

  onState(listener: (state: RedisState) => void): void {
    this.listeners.push(listener);
  }

  /** Follows the client's own connection events once the startup checks passed. */
  watch(): void {
    this.follow(this.client);
  }

  private follow(client: Client): void {
    const down = () => {
      if (client === this.client) this.setState('unreachable');
    };
    client.on('end', down);
    client.on('reconnecting', down);
    client.on('ready', () => {
      if (client !== this.client) return;
      this.startedAt = undefined;
      this.scheduleProbe(0);
    });
  }

  /**
   * One command, bounded by the command timeout. The client's own timeout
   * stops once a command is written, so a stalled Redis is caught here; the
   * connection is then replaced, since a late reply would answer the wrong
   * command (security C4).
   */
  private async command(args: string[]): Promise<unknown> {
    const client = this.client;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CommandTimeout()), this.timeoutMs);
    });
    try {
      return await Promise.race([client.sendCommand(args, { timeout: this.timeoutMs }), timeout]);
    } catch (err) {
      if (err instanceof CommandTimeout) this.replace(client);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Drops a stalled connection and starts a new one (it reconnects with back-off). */
  private replace(stalled: Client): void {
    if (stalled !== this.client || this.closed) return;
    this.setState('unreachable');
    this.probing = false;
    stalled.destroy();
    const next = this.make();
    this.client = next;
    this.startedAt = Date.now();
    this.follow(next);
    next.connect().catch(() => undefined);
    this.scheduleProbe(REDIS_PROBE_INTERVAL_MS);
  }

  async send(args: readonly string[]): Promise<unknown> {
    try {
      return await this.command([...args]);
    } catch (err) {
      throw this.classify(err);
    }
  }

  async script(
    script: LuaScript,
    keys: readonly string[],
    args: readonly string[],
  ): Promise<unknown> {
    const tail = [String(keys.length), ...keys, ...args];
    try {
      return await this.command(['EVALSHA', script.sha, ...tail]);
    } catch (err) {
      if (replyCode(err) !== 'NOSCRIPT') throw this.classify(err);
    }
    try {
      return await this.command(['EVAL', script.source, ...tail]);
    } catch (err) {
      throw this.classify(err);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.probeTimer);
    const client = this.client;
    let timer: NodeJS.Timeout | undefined;
    try {
      // A stalled Redis never answers the close: give up after the timeout.
      if (client.isOpen) {
        await Promise.race([
          client.close(),
          new Promise((resolve) => {
            timer = setTimeout(resolve, this.timeoutMs);
          }),
        ]);
      }
    } catch {
      // Destroyed below.
    } finally {
      clearTimeout(timer);
      client.destroy();
    }
  }

  private classify(err: unknown): Error {
    if (isUnavailable(err)) {
      this.setState('unreachable');
      this.scheduleProbe(REDIS_PROBE_INTERVAL_MS);
      return new StorageUnavailableError();
    }
    return new StorageReplyError(replyCode(err) ?? 'ERR');
  }

  private setState(state: RedisState): void {
    if (this.current === state || this.closed) return;
    this.current = state;
    if (state === 'unreachable') {
      this.logger.warn({ event: 'redis_unreachable' }, 'redis unreachable');
    } else {
      this.logger.info({ event: 'redis_connected' }, 'redis connected');
    }
    for (const listener of this.listeners) listener(state);
  }

  /** PING until it answers; only then is the state `connected` again (security C4). */
  private scheduleProbe(delayMs: number): void {
    if (this.closed || this.probing) return;
    clearTimeout(this.probeTimer);
    this.probeTimer = setTimeout(() => void this.probe(), delayMs);
    this.probeTimer.unref();
  }

  private async probe(): Promise<void> {
    if (this.closed || this.probing) return;
    this.probing = true;
    let ok = false;
    try {
      ok = (await this.command(['PING'])) === 'PONG';
    } catch {
      ok = false;
    } finally {
      this.probing = false;
    }
    if (ok) {
      this.setState('connected');
      return;
    }
    // A new connection that never got ready (its handshake was lost): again.
    if (this.startedAt !== undefined && Date.now() - this.startedAt > this.connectTimeoutMs) {
      this.replace(this.client);
      return;
    }
    this.scheduleProbe(REDIS_PROBE_INTERVAL_MS);
  }
}
