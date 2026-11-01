/**
 * Lazy, typed access to the few host globals the client needs. Nothing here
 * runs at import time (AC7): every global is looked up on each call, so the
 * package can be imported during SSR, and fake timers in tests work.
 */

/** Ready states of a WHATWG WebSocket. */
export const WS_CONNECTING = 0;
export const WS_OPEN = 1;

export interface WebSocketMessageEventLike {
  readonly data: unknown;
}

export interface WebSocketCloseEventLike {
  readonly code: number;
  readonly reason: string;
}

/**
 * The WHATWG WebSocket subset the client uses. The browser `WebSocket`,
 * Node's global `WebSocket` and the `ws` package (v8) all fit it.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: never) => void,
  ): void;
  removeEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: never) => void,
  ): void;
}

export type WebSocketConstructorLike = new (url: string) => WebSocketLike;

interface TextEncoderLike {
  encode(input: string): { readonly length: number };
}

export interface UrlLike {
  readonly href: string;
  readonly protocol: string;
  readonly hostname: string;
  readonly username: string;
  readonly password: string;
  readonly hash: string;
}

interface HostGlobals {
  WebSocket?: WebSocketConstructorLike;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  TextEncoder?: new () => TextEncoderLike;
  URL?: new (url: string) => UrlLike;
}

function host(): HostGlobals {
  return globalThis as unknown as HostGlobals;
}

/** The global WebSocket constructor, if there is one. Read only when connecting (AC4, AC6). */
export function globalWebSocket(): WebSocketConstructorLike | undefined {
  const ctor = host().WebSocket;
  return typeof ctor === 'function' ? ctor : undefined;
}

/** Largest delay `setTimeout` honours; larger values fire after about 1 ms (M1). */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** Clamps a delay to `[0, 2^31-1]`; `NaN` becomes 0 (M1). */
export function clampDelay(ms: number): number {
  if (Number.isNaN(ms) || ms < 0) return 0;
  return Math.min(ms, MAX_TIMER_MS);
}

declare const timerBrand: unique symbol;
/** Opaque handle of a timer started with `setClampedTimeout`. */
export type TimerHandle = { readonly [timerBrand]: true };

/** The only way the client starts a timer: the delay is always clamped (M1). */
export function setClampedTimeout(callback: () => void, ms: number): TimerHandle {
  const start = host().setTimeout;
  if (typeof start !== 'function') throw new TypeError('setTimeout is not available');
  return start(callback, clampDelay(ms)) as TimerHandle;
}

export function clearTimer(handle: TimerHandle | undefined): void {
  if (handle === undefined) return;
  const clear = host().clearTimeout;
  if (typeof clear === 'function') clear(handle);
}

/** Current time in ms, read on each call (fake timers mock `Date`). */
export function now(): number {
  return Date.now();
}

/** UTF-8 encoder from the host. */
export function textEncoder(): TextEncoderLike {
  const Encoder = host().TextEncoder;
  if (typeof Encoder !== 'function') throw new TypeError('TextEncoder is not available');
  return new Encoder();
}

/** Parses a URL with the host's WHATWG `URL`; throws if it is invalid or `URL` is missing. */
export function parseUrl(url: string): UrlLike {
  const Url = host().URL;
  if (typeof Url !== 'function') throw new TypeError('URL is not available');
  return new Url(url);
}
