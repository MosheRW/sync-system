import { MAX_API_KEY_LENGTH, MAX_APP_VERSION_INPUT_LENGTH } from '@sync-system/protocol';
import { SyncClientError } from './errors.js';
import { MAX_TIMER_MS, type WebSocketConstructorLike } from './host.js';
import type { SyncClientLogger } from './logger.js';

export interface ReconnectOptions {
  /** First backoff cap in ms. Default 500, at least 100 (R2-L1). */
  initialDelayMs?: number;
  /** Largest backoff cap in ms. Default 10 000, at least 1000 and `initialDelayMs` (R2-L1). */
  maxDelayMs?: number;
  /** Reconnect attempts per `connect()` run. Default `Infinity`. */
  maxAttempts?: number;
  /** Connected this long before the backoff resets (H1). Default 10 000, at least 1000 (R2-L1). */
  stableAfterMs?: number;
}

export interface SyncClientOptions {
  /** `wss://...`; `ws://` only for loopback hosts or with `allowInsecureTransport`. */
  url: string;
  /** The app's API key. Sent only in `hello`; never put it in the URL. */
  apiKey: string;
  /** The app's version (semver, checked by the server). */
  appVersion: string;
  /** WebSocket implementation (AC5). Default: the global `WebSocket`, read in `connect()`. */
  WebSocket?: WebSocketConstructorLike;
  reconnect?: ReconnectOptions;
  /** Timeout in ms for open + handshake, create and join. Position acks wait twice this. Default 10 000. */
  requestTimeoutMs?: number;
  /** Must be exactly `true` to allow `ws://` to a non-loopback host. Local development or private networks only. */
  allowInsecureTransport?: boolean;
  /** Opt-in logger (AC32). Default: no logging. */
  logger?: SyncClientLogger;
  /** Random source for backoff jitter, in `[0, 1)`. Default `Math.random`. */
  random?: () => number;
}

/** Validated copy of the options. The original object is never kept (L4). */
export interface ResolvedOptions {
  url: string;
  apiKey: string;
  appVersion: string;
  WebSocket: WebSocketConstructorLike | undefined;
  initialDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
  stableAfterMs: number;
  requestTimeoutMs: number;
  allowInsecureTransport: boolean;
  logger: SyncClientLogger | undefined;
  random: (() => number) | undefined;
}

export const DEFAULT_INITIAL_DELAY_MS = 500;
export const DEFAULT_MAX_DELAY_MS = 10_000;
export const DEFAULT_MAX_ATTEMPTS = Number.POSITIVE_INFINITY;
export const DEFAULT_STABLE_AFTER_MS = 10_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Floors that keep the H1 and M3 controls on (R2-L1). */
export const MIN_INITIAL_DELAY_MS = 100;
export const MIN_MAX_DELAY_MS = 1_000;
export const MIN_STABLE_AFTER_MS = 1_000;

function invalid(field: string): SyncClientError<'INVALID_OPTIONS'> {
  return new SyncClientError('INVALID_OPTIONS', { details: { field } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A finite number in `[min, 2^31-1]`, or the default when undefined (M1). */
function readMs(
  source: Record<string, unknown>,
  key: string,
  field: string,
  def: number,
  min: number,
): number {
  const value = source[key];
  if (value === undefined) return def;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > MAX_TIMER_MS) {
    throw invalid(field);
  }
  return value;
}

function readString(source: Record<string, unknown>, key: string, maxLength: number): string {
  const value = source[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw invalid(key);
  }
  return value;
}

/**
 * Validates the constructor options and returns a private copy. Every
 * failure throws `INVALID_OPTIONS { field }`; values are never echoed.
 */
export function resolveOptions(options: unknown): ResolvedOptions {
  if (!isRecord(options)) throw invalid('options');
  // Each property is read once, so a getter cannot change it between check and use.
  const source: Record<string, unknown> = {
    url: options.url,
    apiKey: options.apiKey,
    appVersion: options.appVersion,
    WebSocket: options.WebSocket,
    reconnect: options.reconnect,
    requestTimeoutMs: options.requestTimeoutMs,
    allowInsecureTransport: options.allowInsecureTransport,
    logger: options.logger,
    random: options.random,
  };

  const url = source.url;
  if (typeof url !== 'string' || url.length === 0) throw invalid('url');

  const apiKey = readString(source, 'apiKey', MAX_API_KEY_LENGTH);
  const appVersion = readString(source, 'appVersion', MAX_APP_VERSION_INPUT_LENGTH);

  if (source.WebSocket !== undefined && typeof source.WebSocket !== 'function') {
    throw invalid('WebSocket');
  }
  if (
    source.allowInsecureTransport !== undefined &&
    typeof source.allowInsecureTransport !== 'boolean'
  ) {
    throw invalid('allowInsecureTransport');
  }
  if (source.logger !== undefined && !isRecord(source.logger)) throw invalid('logger');
  if (source.random !== undefined && typeof source.random !== 'function') throw invalid('random');

  const rawReconnect = source.reconnect;
  if (rawReconnect !== undefined && !isRecord(rawReconnect)) throw invalid('reconnect');
  const reconnect: Record<string, unknown> = {
    initialDelayMs: rawReconnect?.initialDelayMs,
    maxDelayMs: rawReconnect?.maxDelayMs,
    maxAttempts: rawReconnect?.maxAttempts,
    stableAfterMs: rawReconnect?.stableAfterMs,
  };

  const initialDelayMs = readMs(
    reconnect,
    'initialDelayMs',
    'reconnect.initialDelayMs',
    DEFAULT_INITIAL_DELAY_MS,
    MIN_INITIAL_DELAY_MS,
  );
  const maxDelayMs = readMs(
    reconnect,
    'maxDelayMs',
    'reconnect.maxDelayMs',
    Math.max(DEFAULT_MAX_DELAY_MS, initialDelayMs),
    MIN_MAX_DELAY_MS,
  );
  if (maxDelayMs < initialDelayMs) throw invalid('reconnect.maxDelayMs');
  const stableAfterMs = readMs(
    reconnect,
    'stableAfterMs',
    'reconnect.stableAfterMs',
    DEFAULT_STABLE_AFTER_MS,
    MIN_STABLE_AFTER_MS,
  );

  let maxAttempts = DEFAULT_MAX_ATTEMPTS;
  if (reconnect.maxAttempts !== undefined) {
    const value = reconnect.maxAttempts;
    const ok =
      typeof value === 'number' &&
      (value === Number.POSITIVE_INFINITY || (Number.isSafeInteger(value) && value >= 1));
    if (!ok) throw invalid('reconnect.maxAttempts');
    maxAttempts = value;
  }

  const requestTimeoutMs = readMs(
    source,
    'requestTimeoutMs',
    'requestTimeoutMs',
    DEFAULT_REQUEST_TIMEOUT_MS,
    1,
  );
  // The position ack timeout is twice this and must still fit a timer (M1, M4).
  if (2 * requestTimeoutMs > MAX_TIMER_MS) throw invalid('requestTimeoutMs');

  return {
    url,
    apiKey,
    appVersion,
    WebSocket: source.WebSocket as WebSocketConstructorLike | undefined,
    initialDelayMs,
    maxDelayMs,
    maxAttempts,
    stableAfterMs,
    requestTimeoutMs,
    allowInsecureTransport: source.allowInsecureTransport === true,
    logger: source.logger,
    random: source.random as (() => number) | undefined,
  };
}
