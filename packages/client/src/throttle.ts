import type { JsonValue } from '@sync-system/protocol';
import { type TimerHandle, clearTimer, now, setClampedTimeout } from './host.js';

/** The server's sliding window for leader updates. */
export const THROTTLE_WINDOW_MS = 1_000;
/** Margin for network jitter between the client's send time and the server's receive time. */
export const THROTTLE_SAFETY_MS = 100;
/** Longest wait before re-sending a rate-limited position (M1). */
export const MAX_RATE_LIMIT_RETRY_MS = 10_000;
/** How many times the same position is put back after RATE_LIMITED (L5). */
export const MAX_REQUEUES = 3;

const WINDOW_MS = THROTTLE_WINDOW_MS + THROTTLE_SAFETY_MS;

/**
 * Leader position throttle (Q2, AC21). At most `limit` sends in any window
 * of 1.1 s. Calls made faster than that are coalesced: only the latest
 * pending position is kept, and it is sent as soon as the window allows
 * (trailing send). At most one timer runs at a time.
 */
export class PositionThrottle {
  readonly #limit: number;
  readonly #send: (position: JsonValue) => void;
  /** Send times, a ring buffer of at most `limit` entries (M1). */
  readonly #times: number[] = [];
  /** Index of the oldest entry once the ring is full. */
  #oldest = 0;
  #pending: { value: JsonValue } | undefined;
  #timer: TimerHandle | undefined;
  #requeued: { value: JsonValue; count: number } | undefined;

  /** `limit` must already be checked against the client bounds (positive, at most 100). */
  constructor(limit: number, send: (position: JsonValue) => void) {
    this.#limit = limit;
    this.#send = send;
  }

  /** True while a trailing send is scheduled. */
  get scheduled(): boolean {
    return this.#timer !== undefined;
  }

  /** Stores `position` as the latest and sends it now or when the window allows. */
  submit(position: JsonValue): void {
    this.#pending = { value: position };
    this.#requeued = undefined;
    this.#flush();
  }

  /**
   * The server answered RATE_LIMITED for `position` (AC23). If nothing newer
   * is pending, put it back and send it after `retryAfterMs`, clamped to
   * `[next window slot, 10 s]`; a missing value means the next slot (M1, L1).
   * The same position is put back at most 3 times (L5).
   */
  rateLimited(position: JsonValue, retryAfterMs: number | undefined): void {
    if (this.#pending !== undefined) return;
    if (this.#requeued?.value === position) {
      this.#requeued.count += 1;
    } else {
      this.#requeued = { value: position, count: 1 };
    }
    if (this.#requeued.count > MAX_REQUEUES) return;

    this.#pending = { value: position };
    const slot = this.#waitMs();
    const delay =
      retryAfterMs === undefined
        ? slot
        : Math.max(slot, Math.min(retryAfterMs, MAX_RATE_LIMIT_RETRY_MS));
    this.#schedule(delay);
  }

  /** Drops the pending position and the timer (disconnect, close, group ended). */
  cancel(): void {
    clearTimer(this.#timer);
    this.#timer = undefined;
    this.#pending = undefined;
    this.#requeued = undefined;
  }

  /** 0 if a send is allowed now, else the ms until the oldest send leaves the window. */
  #waitMs(): number {
    if (this.#times.length < this.#limit) return 0;
    const oldest = this.#times[this.#oldest]!;
    return Math.max(0, oldest + WINDOW_MS - now());
  }

  #flush(): void {
    if (this.#pending === undefined || this.#timer !== undefined) return;
    const wait = this.#waitMs();
    if (wait > 0) {
      this.#schedule(wait);
      return;
    }
    const { value } = this.#pending;
    this.#pending = undefined;
    this.#record(now());
    this.#send(value);
  }

  #schedule(delay: number): void {
    clearTimer(this.#timer);
    this.#timer = setClampedTimeout(() => {
      this.#timer = undefined;
      this.#flush();
    }, delay);
  }

  #record(time: number): void {
    if (this.#times.length < this.#limit) {
      this.#times.push(time);
      return;
    }
    this.#times[this.#oldest] = time;
    this.#oldest = (this.#oldest + 1) % this.#limit;
  }
}
