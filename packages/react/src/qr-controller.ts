import {
  type CodesChangedReason,
  type QrTicket,
  SyncClientError,
  type SyncClientEvents,
} from '@sync-system/client';
import { type TimerHandle, clearTimer, microtask, now, setTimer } from './host.js';
import { IDLE_QR } from './server-state.js';
import { toSyncError } from './to-sync-error.js';
import type { QrTicketState, SyncClientLike } from './types.js';

/** No QR ticket is issued more often than this, automatically or by `refresh()` (R2, R9). */
export const QR_MIN_INTERVAL_MS = 10_000;
/** Longest wait after `RATE_LIMITED` (R9). */
export const QR_MAX_RATE_LIMIT_WAIT_MS = 60_000;
/** Re-issue at this share of the ticket's lifetime (AC18). */
export const QR_REISSUE_SHARE = 0.8;

/**
 * Code changes that revoke every outstanding ticket (R1): a re-issue follows
 * at once. `door_failures` and `created` keep the ticket generation.
 */
const REVOKING: ReadonlySet<CodesChangedReason> = new Set<CodesChangedReason>([
  'rotated',
  'resumed',
  'member_removed',
  'superseded',
]);

/** What the controller needs from its store. */
export interface QrHost {
  readonly client: SyncClientLike | null;
  /** The group ID this client leads while connected, else null. */
  connectedLeadGroupId(): string | null;
  /** The controller's state changed. */
  changed(): void;
}

/**
 * The QR ticket re-issue timer (AC18, D5), shared by every `useQrTicket`
 * consumer of one store and ref-counted, with a deferred release so
 * StrictMode never issues twice. It runs only while a consumer is mounted
 * and enabled and this client leads an active group on a live connection.
 *
 * - Issues on start, re-issues at 80 % of the lifetime (never sooner than
 *   10 s apart), and at once after a revoking code change (R1). A revoking
 *   change drops the ticket at once but never cuts a `RATE_LIMITED` wait
 *   short; nothing (stop, remount, group switch) clears that wait except
 *   a new connection, since the server's `qr.issue` budget is per
 *   connection. The 10 s floor outlives reconnects, so a reconnect storm
 *   still issues at most once per 10 s.
 * - `refresh()` is a no-op while a request is in flight, during a
 *   `RATE_LIMITED` wait and within 10 s of the last issue, unless the
 *   ticket expired (R2).
 * - Results of an older request are dropped (generation). No ticket that
 *   expired or belongs to revoked codes is ever exposed (R9).
 * - `JOIN_METHOD_UNAVAILABLE`: `unavailable`; other errors: `error`, no
 *   automatic retry; `RATE_LIMITED`: one retry after the server's delay
 *   (10 s to 60 s).
 * - Stopping drops the ticket: the credential leaves memory when nothing
 *   shows it. Over no client everything is a no-op (R6).
 */
export class QrTicketController {
  readonly #host: QrHost;
  #state: QrTicketState = IDLE_QR;
  #refs = 0;
  #releaseTimer: TimerHandle | undefined;
  #issueTimer: TimerHandle | undefined;
  #expiryTimer: TimerHandle | undefined;
  /** Bumped by every issue and stop: older results and scheduled issues are dropped. */
  #generation = 0;
  #inFlight = false;
  #scheduled = false;
  #lastIssueAt = Number.NEGATIVE_INFINITY;
  #rateLimitedUntil = 0;
  /** The group the ticket is for. */
  #group: string | null = null;
  /** The code generation the current request or ticket was issued under. */
  #codesGeneration: number | null = null;

  constructor(host: QrHost) {
    this.#host = host;
  }

  get state(): QrTicketState {
    return this.#state;
  }

  /** A consumer mounted (and is enabled). */
  acquire(): void {
    if (this.#host.client === null) return;
    this.#refs += 1;
    clearTimer(this.#releaseTimer);
    this.#releaseTimer = undefined;
    this.evaluate();
  }

  /** A consumer unmounted or was disabled; the last one stops the controller a tick later. */
  release(): void {
    if (this.#host.client === null || this.#refs === 0) return;
    this.#refs -= 1;
    if (this.#refs > 0 || this.#releaseTimer !== undefined) return;
    this.#releaseTimer = setTimer(() => {
      this.#releaseTimer = undefined;
      if (this.#refs === 0) this.#stop();
    }, 0);
  }

  /** Manual re-issue (R2): coalesced, at most one per 10 s unless the ticket expired. */
  refresh(): void {
    if (this.#host.client === null || this.#refs === 0) return;
    const lead = this.#host.connectedLeadGroupId();
    if (lead === null || lead !== this.#group) return;
    if (this.#inFlight) return;
    const time = now();
    if (time < this.#rateLimitedUntil) return;
    const ticket = ticketOf(this.#state);
    const expired = ticket !== null && ticket.expiresAt <= time;
    if (time - this.#lastIssueAt < QR_MIN_INTERVAL_MS && !expired) return;
    this.#issue();
  }

  /** Re-checks eligibility; called on every store change. */
  evaluate(): void {
    if (this.#host.client === null) return;
    const lead = this.#refs > 0 ? this.#host.connectedLeadGroupId() : null;
    if (lead === null) {
      if (this.#refs === 0 && this.#releaseTimer !== undefined) return;
      this.#stop();
      return;
    }
    if (lead !== this.#group) {
      this.#stop();
      this.#group = lead;
      this.#schedule();
      return;
    }
    // Idle, or loading with nothing pending (a release was cancelled before
    // a scheduled issue ran): schedule the issue.
    if (
      (this.#state === IDLE_QR || this.#state.status === 'loading') &&
      !this.#inFlight &&
      !this.#scheduled &&
      this.#issueTimer === undefined
    ) {
      this.#schedule();
    }
  }

  /**
   * The client opened a new connection (a reconnect or a new session). The
   * server forgot the old connection's `qr.issue` budget, so a pending
   * `RATE_LIMITED` wait ends; the 10 s floor since the last issue stays.
   */
  connectionOpened(): void {
    this.#rateLimitedUntil = 0;
  }

  /** A `codesChanged` event (R1). */
  codesChanged(event: SyncClientEvents['codesChanged']): void {
    if (this.#host.client === null || this.#refs === 0) return;
    if (!REVOKING.has(event.reason)) return;
    const lead = this.#host.connectedLeadGroupId();
    if (lead === null || lead !== event.groupId || lead !== this.#group) return;
    // A request or ticket issued under these codes is already valid.
    if (
      this.#codesGeneration === event.codes.generation &&
      (this.#inFlight || this.#state.status === 'ready')
    ) {
      return;
    }
    this.#clearTimers();
    this.#generation += 1;
    this.#inFlight = false;
    // The revoked ticket goes at once; a pending RATE_LIMITED wait is kept.
    this.#set(Object.freeze({ status: 'loading' as const, ticket: null }));
    const wait = this.#rateLimitedUntil - now();
    if (wait > 0) this.#armIssue(wait);
    else this.#issue();
  }

  /**
   * Issues now if allowed, else at the 10 s floor or the end of a
   * `RATE_LIMITED` wait; never twice in one tick. The state reads `loading`
   * until the issue.
   */
  #schedule(): void {
    if (this.#scheduled || this.#inFlight || this.#issueTimer !== undefined) return;
    // An eligible leader with an issue on the way reads `loading`, never `idle`.
    if (this.#state === IDLE_QR) {
      this.#set(Object.freeze({ status: 'loading' as const, ticket: null }));
    }
    const wait = Math.max(this.#lastIssueAt + QR_MIN_INTERVAL_MS, this.#rateLimitedUntil) - now();
    const generation = this.#generation;
    if (wait > 0) {
      this.#issueTimer = setTimer(() => {
        this.#issueTimer = undefined;
        if (generation === this.#generation) this.#issue();
      }, wait);
      return;
    }
    this.#scheduled = true;
    // After the current synchronous work: a revoking codesChanged in the
    // same tick issues first, and this one then sees the request in flight.
    microtask(() => {
      this.#scheduled = false;
      if (generation !== this.#generation || this.#inFlight) return;
      if (this.#host.connectedLeadGroupId() !== this.#group || this.#refs === 0) return;
      this.#issue();
    });
  }

  #issue(): void {
    const client = this.#host.client;
    if (client === null) return;
    clearTimer(this.#issueTimer);
    this.#issueTimer = undefined;
    const generation = ++this.#generation;
    this.#inFlight = true;
    this.#lastIssueAt = now();
    this.#codesGeneration = client.getJoinCodes()?.generation ?? null;
    const current = this.#validTicket();
    if (this.#state.status !== 'loading' || ticketOf(this.#state) !== current) {
      this.#set(Object.freeze({ status: 'loading' as const, ticket: current }));
    }
    let request: Promise<QrTicket>;
    try {
      request = client.issueQrTicket();
    } catch (error) {
      request = Promise.reject(toSyncError(error));
    }
    request.then(
      (ticket) => {
        if (generation !== this.#generation) return;
        this.#inFlight = false;
        this.#onTicket(ticket);
      },
      (error: unknown) => {
        if (generation !== this.#generation) return;
        this.#inFlight = false;
        this.#onError(toSyncError(error));
      },
    );
  }

  #onTicket(ticket: QrTicket): void {
    const time = now();
    const expiresAt = ticket.expiresAt;
    if (!Number.isFinite(expiresAt) || expiresAt <= time) {
      // Never expose an expired ticket (R9); no automatic retry.
      this.#set(
        Object.freeze({
          status: 'error' as const,
          error: new SyncClientError('QR_EXPIRED'),
          ticket: null,
        }),
      );
      return;
    }
    this.#set(Object.freeze({ status: 'ready' as const, ticket }));
    const lifetime = expiresAt - time;
    this.#armIssue(Math.max(QR_MIN_INTERVAL_MS, QR_REISSUE_SHARE * lifetime));
    this.#armExpiry(ticket);
  }

  #onError(error: SyncClientError): void {
    const ticket = this.#validTicket();
    if (error.code === 'JOIN_METHOD_UNAVAILABLE') {
      this.#clearTimers();
      this.#set(Object.freeze({ status: 'unavailable' as const }));
      return;
    }
    this.#set(Object.freeze({ status: 'error' as const, error, ticket }));
    if (ticket !== null) this.#armExpiry(ticket);
    if (error.code === 'RATE_LIMITED') {
      const after = (error as SyncClientError<'RATE_LIMITED'>).details?.retryAfterMs;
      const wait =
        typeof after === 'number' && Number.isFinite(after)
          ? Math.min(Math.max(after, QR_MIN_INTERVAL_MS), QR_MAX_RATE_LIMIT_WAIT_MS)
          : QR_MIN_INTERVAL_MS;
      this.#rateLimitedUntil = now() + wait;
      this.#armIssue(wait);
    }
    // Any other error: no automatic retry; eligibility changes or refresh() issue again.
  }

  #armIssue(delay: number): void {
    clearTimer(this.#issueTimer);
    const generation = this.#generation;
    this.#issueTimer = setTimer(() => {
      this.#issueTimer = undefined;
      if (generation === this.#generation) this.#issue();
    }, delay);
  }

  /** Drops the ticket from the state when it expires (R9). */
  #armExpiry(ticket: QrTicket): void {
    clearTimer(this.#expiryTimer);
    this.#expiryTimer = setTimer(
      () => {
        this.#expiryTimer = undefined;
        const state = this.#state;
        if (ticketOf(state) !== ticket) return;
        this.#set(
          state.status === 'error'
            ? Object.freeze({ ...state, ticket: null })
            : Object.freeze({ status: 'loading' as const, ticket: null }),
        );
      },
      Math.max(0, ticket.expiresAt - now()),
    );
  }

  #validTicket(): QrTicket | null {
    const ticket = ticketOf(this.#state);
    return ticket !== null && ticket.expiresAt > now() ? ticket : null;
  }

  #clearTimers(): void {
    clearTimer(this.#issueTimer);
    this.#issueTimer = undefined;
    clearTimer(this.#expiryTimer);
    this.#expiryTimer = undefined;
  }

  /** Clears the timers, drops the ticket and ignores every pending result. */
  #stop(): void {
    this.#clearTimers();
    this.#generation += 1;
    this.#inFlight = false;
    // The RATE_LIMITED wait outlives a stop: it ends on its own (at most 60 s).
    this.#group = null;
    this.#codesGeneration = null;
    this.#set(IDLE_QR);
  }

  #set(state: QrTicketState): void {
    if (state === this.#state) return;
    this.#state = state;
    this.#host.changed();
  }
}

function ticketOf(state: QrTicketState): QrTicket | null {
  return state.status === 'loading' || state.status === 'ready' || state.status === 'error'
    ? state.ticket
    : null;
}
