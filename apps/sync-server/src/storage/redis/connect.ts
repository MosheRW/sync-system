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
import { StorageReplyError, StorageUnavailableError } from '../errors.js';

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
export interface RedisLink {
  send(args: readonly string[]): Promise<unknown>;
  script(script: LuaScript, keys: readonly string[], args: readonly string[]): Promise<unknown>;
  readonly state: RedisState;
  /** Called on every state change (`connected` after a successful probe). */
  onState(listener: (state: RedisState) => void): void;
  close(): Promise<void>;
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
 * The `Startup error` text for a failed connection (#35 AC4), from the
 * error code only: never the message, host, port, user or password.
 */
export function startupMessage(err: unknown): string {
  const reply = replyCode(err);
  if (reply !== undefined && AUTH_REPLIES.has(reply)) {
    return 'Redis authentication failed (REDIS_URL)';
  }
  const code = errnoCode(err) ?? '';
  if (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_') || TLS_CODES.has(code)) {
    return 'Redis TLS handshake failed (REDIS_URL)';
  }
  if (code.startsWith('CERT_')) return 'Redis TLS handshake failed (REDIS_URL)';
  if (
    UNREACHABLE_CODES.has(code) ||
    errorClass(err) === 'ConnectionTimeoutError' ||
    errorClass(err) === 'TimeoutError' ||
    errorClass(err) === 'StartupTimeout'
  ) {
    return 'Redis is unreachable (REDIS_URL)';
  }
  return 'Redis connection failed (REDIS_URL)';
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

  const link = new ClientLink(client, settings.commandTimeoutMs, logger);
  try {
    const server = String(await link.send(['INFO', 'server']));
    const version = semver.coerce(infoField(server, 'redis_version') ?? '');
    if (version === null || semver.lt(version, MIN_REDIS_VERSION)) {
      await link.close();
      return { ok: false, message: 'Redis 7.2 or later is required' };
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
      message:
        replyCode(err) === 'NOPERM' ? startupMessage(err) : 'Redis connection failed (REDIS_URL)',
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
  sendCommand(args: string[], options: { timeout: number }): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  readonly isOpen: boolean;
  close(): Promise<unknown>;
  destroy(): void;
}

/** The connection with timeouts, error classes and the state machine (ADR 0014, security C4). */
class ClientLink implements RedisLink {
  private current: RedisState = 'connected';
  private readonly listeners: Array<(state: RedisState) => void> = [];
  private probeTimer: NodeJS.Timeout | undefined;
  private probing = false;
  private closed = false;

  constructor(
    private readonly client: Client,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
  ) {}

  get state(): RedisState {
    return this.current;
  }

  onState(listener: (state: RedisState) => void): void {
    this.listeners.push(listener);
  }

  /** Follows the client's own connection events once the startup checks passed. */
  watch(): void {
    const down = () => this.setState('unreachable');
    this.client.on('end', down);
    this.client.on('reconnecting', down);
    this.client.on('ready', () => this.scheduleProbe(0));
  }

  async send(args: readonly string[]): Promise<unknown> {
    try {
      return await this.client.sendCommand([...args], { timeout: this.timeoutMs });
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
      return await this.client.sendCommand(['EVALSHA', script.sha, ...tail], {
        timeout: this.timeoutMs,
      });
    } catch (err) {
      if (replyCode(err) !== 'NOSCRIPT') throw this.classify(err);
    }
    try {
      return await this.client.sendCommand(['EVAL', script.source, ...tail], {
        timeout: this.timeoutMs,
      });
    } catch (err) {
      throw this.classify(err);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.probeTimer);
    try {
      if (this.client.isOpen) await this.client.close();
    } catch {
      this.client.destroy();
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
      ok = (await this.client.sendCommand(['PING'], { timeout: this.timeoutMs })) === 'PONG';
    } catch {
      ok = false;
    } finally {
      this.probing = false;
    }
    if (ok) this.setState('connected');
    else this.scheduleProbe(REDIS_PROBE_INTERVAL_MS);
  }
}
