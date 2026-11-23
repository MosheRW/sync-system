import type { JsonValue, ServerMessage } from '@mosherw/sync-system-protocol';
import { type RequestKind, SyncClientError } from './errors.js';
import { type TimerHandle, clearTimer, setClampedTimeout } from './host.js';

/**
 * What a timeout means (M4, Q-C):
 * - `drop`: hello, create, join. The link may be half-open, and a late reply
 *   would leave client and server out of step, so the socket is dropped.
 * - `ack`: position updates. Only an error is reported; the socket is dropped
 *   only if the server has been silent the whole time.
 */
export type TimeoutKind = 'drop' | 'ack';

export interface PendingRequest {
  readonly reqId: string;
  readonly kind: RequestKind;
  readonly timeoutKind: TimeoutKind;
  /** The position sent, for `position.update` (used to re-queue on RATE_LIMITED). */
  readonly position?: JsonValue;
  readonly resolve: (message: ServerMessage) => void;
  readonly reject: (error: SyncClientError) => void;
}

export interface AddRequest {
  kind: RequestKind;
  timeoutKind: TimeoutKind;
  timeoutMs: number;
  position?: JsonValue;
  resolve: (message: ServerMessage) => void;
  reject: (error: SyncClientError) => void;
}

interface Entry extends PendingRequest {
  timer: TimerHandle;
}

/**
 * Matches replies to requests by `reqId` (AC17). Uses callbacks, not
 * promises, so no internal promise can ever reject unhandled (L6).
 */
export class RequestTracker {
  #counter = 0;
  readonly #pending = new Map<string, Entry>();
  readonly #onTimeout: (request: PendingRequest) => void;

  /** `onTimeout` runs after the timed-out request was rejected with REQUEST_TIMEOUT. */
  constructor(onTimeout: (request: PendingRequest) => void) {
    this.#onTimeout = onTimeout;
  }

  get size(): number {
    return this.#pending.size;
  }

  /** A new `reqId`: `c1`, `c2`, ... unique for the life of the client. */
  nextId(): string {
    this.#counter += 1;
    return `c${this.#counter}`;
  }

  /** Tracks a request that was sent with `reqId`. */
  add(reqId: string, request: AddRequest): void {
    const timer = setClampedTimeout(() => this.#timeout(reqId), request.timeoutMs);
    const entry: Entry = {
      reqId,
      kind: request.kind,
      timeoutKind: request.timeoutKind,
      resolve: request.resolve,
      reject: request.reject,
      timer,
      ...(request.position === undefined ? {} : { position: request.position }),
    };
    this.#pending.set(reqId, entry);
  }

  /** The pending request for `reqId`, without removing it. */
  get(reqId: string): PendingRequest | undefined {
    return this.#pending.get(reqId);
  }

  /** Removes and returns the pending request for `reqId`, clearing its timer. */
  take(reqId: string): PendingRequest | undefined {
    const entry = this.#pending.get(reqId);
    if (entry === undefined) return undefined;
    this.#pending.delete(reqId);
    clearTimer(entry.timer);
    return entry;
  }

  /** Rejects every pending request with `error` and clears all timers (AC17, AC28). */
  rejectAll(error: SyncClientError): void {
    const entries = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of entries) {
      clearTimer(entry.timer);
      entry.reject(error);
    }
  }

  #timeout(reqId: string): void {
    const entry = this.#pending.get(reqId);
    if (entry === undefined) return;
    this.#pending.delete(reqId);
    entry.reject(new SyncClientError('REQUEST_TIMEOUT', { request: entry.kind }));
    this.#onTimeout(entry);
  }
}
