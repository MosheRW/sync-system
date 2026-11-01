import type { ErrorMessage, ServerMessage, WelcomeMessage } from '@sync-system/protocol';
import type { BusySignal } from './backoff.js';
import { Emitter, ListenerSet } from './emitter.js';
import {
  type RequestKind,
  SyncClientError,
  fromServerError,
  invalidServerMessage,
} from './errors.js';
import {
  checkHelloOk,
  checkWelcome,
  buildHello,
  classifyClose,
  classifyHandshakeError,
} from './handshake.js';
import { type TimerHandle, clearTimer, globalWebSocket, setClampedTimeout } from './host.js';
import { maxInboundChars } from './limits.js';
import { type LogFields, type LogLevel, log } from './logger.js';
import { type ResolvedOptions, type SyncClientOptions, resolveOptions } from './options.js';
import { type PendingRequest, RequestTracker } from './requests.js';
import type {
  ConnectedInfo,
  ConnectionState,
  GroupState,
  SyncClientEvents,
  SyncClientSnapshot,
} from './state.js';
import { type InboundFrame, Transport } from './transport.js';

/** Handshake phase of the current socket. */
type Phase = 'welcome' | 'hello' | 'ready';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: SyncClientError): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: SyncClientError) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const IDLE_SNAPSHOT: SyncClientSnapshot = Object.freeze({
  connection: Object.freeze({ status: 'idle' as const }),
  group: null,
});

/** An unknown server type is logged only if it looks like a type name (L2). */
const SAFE_TYPE = /^[a-z.]{1,64}$/;

/** Which reply each request expects. */
const REPLY_TYPE: Record<RequestKind, ServerMessage['type']> = {
  hello: 'hello.ok',
  'group.create': 'group.created',
  'group.join': 'group.joined',
  'position.update': 'position.ack',
};

/**
 * Framework-free sync client. See the package README for the full contract.
 *
 * The API key and the options live in `#private` fields only, so they never
 * show up in `JSON.stringify`, `util.inspect` or devtools previews (L4).
 */
export class SyncClient {
  readonly #opts: ResolvedOptions;
  readonly #events: Emitter<SyncClientEvents>;
  readonly #subscribers: ListenerSet<void>;
  readonly #requests: RequestTracker;
  #snapshot: SyncClientSnapshot = IDLE_SNAPSHOT;
  #transport: Transport | undefined;
  #phase: Phase = 'welcome';
  #welcome: WelcomeMessage | undefined;
  #info: ConnectedInfo | undefined;
  #attemptTimer: TimerHandle | undefined;
  /** The promise of the current `connect()` run, until it settles. */
  #run: Deferred<ConnectedInfo> | undefined;

  /** Validates the options (throws `INVALID_OPTIONS`). Touches no host globals except `URL`. */
  constructor(options: SyncClientOptions) {
    this.#opts = resolveOptions(options);
    const onListenerError = (error: unknown) => {
      // Only the name: an app error message may contain app data (L4).
      this.#log('error', 'listener_error', {
        name: error instanceof Error ? error.name : typeof error,
      });
    };
    this.#events = new Emitter<SyncClientEvents>(onListenerError);
    this.#subscribers = new ListenerSet<void>(onListenerError);
    this.#requests = new RequestTracker((request) => this.#onRequestTimeout(request));
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Connects and resolves on `hello.ok` (AC8). From `connecting`,
   * `reconnecting` or `connected` it returns the current attempt (or resolves
   * at once). Rejects on a fatal error, on `close()`, or when it gives up:
   * always `catch` it.
   */
  connect(): Promise<ConnectedInfo> {
    const state = this.#snapshot.connection;
    if (state.status === 'connected' && this.#info) return Promise.resolve(this.#info);
    if (state.status === 'connecting' || state.status === 'reconnecting') {
      this.#run ??= deferred<ConnectedInfo>();
      return this.#run.promise;
    }
    const run = deferred<ConnectedInfo>();
    this.#run = run;
    this.#update({
      connection: { status: 'connecting' },
      group: state.status === 'closed' ? null : this.#snapshot.group,
    });
    this.#openSocket();
    return run.promise;
  }

  /**
   * Stops the client (AC28): closes the socket with 1000, rejects pending
   * requests and `connect()` with `CLOSED`, and cancels every timer.
   * Idempotent and synchronous.
   */
  close(): void {
    if (this.#snapshot.connection.status === 'closed') return;
    const error = new SyncClientError('CLOSED');
    this.#teardown(error);
    this.#update({ connection: { status: 'closed', reason: 'client' } });
    this.#settleRun(error);
  }

  /** Current connection state (same as `getSnapshot().connection`). */
  getState(): ConnectionState {
    return this.#snapshot.connection;
  }

  /** Immutable snapshot that keeps its identity until something changes. */
  getSnapshot(): SyncClientSnapshot {
    return this.#snapshot;
  }

  /** Called after every snapshot change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void {
    return this.#subscribers.add(listener);
  }

  /** Subscribes to a typed event. Returns an unsubscribe function. */
  on<E extends keyof SyncClientEvents>(
    event: E,
    listener: (payload: SyncClientEvents[E]) => void,
  ): () => void {
    return this.#events.on(event, listener);
  }

  off<E extends keyof SyncClientEvents>(
    event: E,
    listener: (payload: SyncClientEvents[E]) => void,
  ): void {
    this.#events.off(event, listener);
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  /** Applies a change: new snapshot -> subscribers -> `state` event (AC19, AC24). */
  #update(change: { connection?: ConnectionState; group?: GroupState | null }): void {
    const previous = this.#snapshot;
    const connection = change.connection ? Object.freeze(change.connection) : previous.connection;
    const group =
      change.group === undefined ? previous.group : change.group && Object.freeze(change.group);
    if (connection === previous.connection && group === previous.group) return;
    this.#snapshot = Object.freeze({ connection, group });
    this.#subscribers.emit();
    if (connection !== previous.connection) {
      this.#log('debug', 'state_changed', { status: connection.status });
      this.#events.emit('state', connection);
    }
  }

  #emitError(error: SyncClientError): void {
    this.#log('debug', 'error_event', { code: error.code });
    this.#events.emit('error', error);
  }

  #log(level: LogLevel, event: string, fields?: LogFields): void {
    log(this.#opts.logger, level, event, fields);
  }

  /** Settles the pending `connect()` promise, if any. */
  #settleRun(result: ConnectedInfo | SyncClientError): void {
    const run = this.#run;
    if (run === undefined) return;
    this.#run = undefined;
    if (result instanceof SyncClientError) run.reject(result);
    else run.resolve(result);
  }

  // ---------------------------------------------------------------------------
  // Socket attempts and the handshake
  // ---------------------------------------------------------------------------

  #openSocket(): void {
    const Ctor = this.#opts.WebSocket ?? globalWebSocket();
    if (Ctor === undefined) {
      this.#fail(new SyncClientError('NO_WEBSOCKET', { fatal: true }));
      return;
    }
    this.#phase = 'welcome';
    this.#welcome = undefined;
    this.#info = undefined;
    this.#log('debug', 'socket_opening');
    let transport: Transport | undefined;
    try {
      transport = new Transport(
        Ctor,
        this.#opts.url,
        {
          onOpen: () => this.#log('debug', 'socket_open'),
          onFrame: (frame) => {
            if (this.#transport === transport) this.#onFrame(frame);
          },
          onClose: (code) => {
            if (this.#transport === transport) this.#onSocketClosed(code);
          },
        },
        maxInboundChars(undefined),
      );
    } catch {
      this.#connectionLost(new SyncClientError('CONNECTION_LOST'));
      return;
    }
    this.#transport = transport;
    // Covers open + welcome + hello.ok (Q-C).
    this.#attemptTimer = setClampedTimeout(() => {
      this.#attemptTimer = undefined;
      this.#log('debug', 'request_timeout', { request: 'hello' });
      this.#connectionLost(new SyncClientError('REQUEST_TIMEOUT', { request: 'hello' }));
    }, this.#opts.requestTimeoutMs);
  }

  #send(message: object): boolean {
    return this.#transport?.send(message) ?? false;
  }

  #onFrame(frame: InboundFrame): void {
    switch (frame.kind) {
      case 'unknown':
        // Forward compatible: a newer server may add event types (AC10).
        this.#log('debug', 'unknown_message', {
          type: SAFE_TYPE.test(frame.type) ? frame.type : '(invalid)',
        });
        return;
      case 'invalid':
        this.#onInvalidFrame(frame.issues, frame.reqId);
        return;
      case 'message':
        this.#onMessage(frame.message);
        return;
    }
  }

  /** A protocol violation never reaches the app as a typed event (AC10). */
  #onInvalidFrame(issues: string[], reqId: string | undefined): void {
    this.#log('debug', 'invalid_message');
    if (this.#phase !== 'ready') {
      // Before hello.ok it ends the attempt; it may be a proxy problem, so retry.
      this.#connectionLost(invalidServerMessage(issues, 'hello'));
      return;
    }
    const request = reqId === undefined ? undefined : this.#requests.take(reqId);
    if (request) {
      request.reject(invalidServerMessage(issues, request.kind));
      return;
    }
    this.#emitError(invalidServerMessage(issues));
  }

  #onMessage(message: ServerMessage): void {
    if (this.#phase === 'welcome') {
      if (message.type === 'welcome') this.#onWelcome(message);
      else if (message.type === 'error') this.#onHandshakeError(message);
      else this.#connectionLost(invalidServerMessage(['type: unexpected_message'], 'hello'));
      return;
    }
    if (this.#phase === 'hello') {
      if (message.type === 'hello.ok') this.#onHelloOk(message);
      else if (message.type === 'error') this.#onHandshakeError(message);
      else this.#connectionLost(invalidServerMessage(['type: unexpected_message'], 'hello'));
      return;
    }
    this.#onReadyMessage(message);
  }

  #onWelcome(welcome: WelcomeMessage): void {
    const unsupported = checkWelcome(welcome);
    if (unsupported) {
      // No hello is sent to a server this client does not support (AC12).
      this.#fail(unsupported);
      return;
    }
    this.#welcome = welcome;
    this.#phase = 'hello';
    this.#send(buildHello(this.#requests.nextId(), this.#opts.apiKey, this.#opts.appVersion));
  }

  #onHelloOk(message: Extract<ServerMessage, { type: 'hello.ok' }>): void {
    const unsupported = checkHelloOk(message, this.#welcome!);
    if (unsupported) {
      this.#fail(unsupported);
      return;
    }
    clearTimer(this.#attemptTimer);
    this.#attemptTimer = undefined;
    const { maxGroupSize, maxLeaderUpdatesPerSecond, maxMessageBytes } = message.limits;
    const limits = Object.freeze({ maxGroupSize, maxLeaderUpdatesPerSecond, maxMessageBytes });
    const info: ConnectedInfo = Object.freeze({ participantId: message.participantId, limits });
    this.#info = info;
    this.#phase = 'ready';
    this.#transport?.setMaxInboundChars(maxInboundChars(limits));
    this.#update({ connection: { status: 'connected', ...info } });
    this.#settleRun(info);
  }

  #onHandshakeError(message: ErrorMessage): void {
    const { error, busy } = classifyHandshakeError(message);
    if (error.fatal) this.#fail(error);
    else this.#connectionLost(error, busy);
  }

  #onReadyMessage(message: ServerMessage): void {
    switch (message.type) {
      case 'welcome':
      case 'hello.ok':
        // Never replaces participantId or limits mid-session (L8).
        this.#emitError(invalidServerMessage(['type: unexpected_message']));
        return;
      case 'group.created':
      case 'group.joined':
      case 'position.ack':
        this.#onReply(message);
        return;
      case 'error':
        this.#onServerError(message);
        return;
      case 'position.updated':
      case 'group.ended':
        return;
    }
  }

  #onReply(message: Extract<ServerMessage, { reqId?: string }>): void {
    if (message.reqId === undefined) return;
    // Unknown reqIds are ignored: a late ack after an ack timeout is harmless (M4).
    const request = this.#requests.take(message.reqId);
    if (request === undefined) return;
    if (REPLY_TYPE[request.kind] !== message.type) {
      request.reject(invalidServerMessage(['type: unexpected_reply'], request.kind));
      return;
    }
    request.resolve(message);
  }

  #onServerError(message: ErrorMessage): void {
    const request = message.reqId === undefined ? undefined : this.#requests.take(message.reqId);
    if (request) {
      request.reject(fromServerError(message, { request: request.kind }));
      return;
    }
    this.#emitError(fromServerError(message));
  }

  #onRequestTimeout(request: PendingRequest): void {
    this.#log('debug', 'request_timeout', { request: request.kind });
  }

  #onSocketClosed(code: number): void {
    this.#log('debug', 'socket_closed', { code });
    const { error, busy } = classifyClose(code, this.#phase !== 'ready');
    if (error.fatal) this.#fail(error);
    else this.#connectionLost(error, busy);
  }

  // ---------------------------------------------------------------------------
  // Endings
  // ---------------------------------------------------------------------------

  /** Drops the socket and everything tied to it. */
  #teardown(requestError: SyncClientError, closeReason?: string): void {
    clearTimer(this.#attemptTimer);
    this.#attemptTimer = undefined;
    const transport = this.#transport;
    this.#transport = undefined;
    transport?.retire(1000, closeReason);
    this.#phase = 'welcome';
    this.#info = undefined;
    this.#requests.rejectAll(requestError);
  }

  /** A fatal error: closed, no automatic reconnect (AC14). */
  #fail(error: SyncClientError): void {
    this.#log('warn', 'fatal_error', { code: error.code });
    this.#teardown(error, error.code);
    this.#update({ connection: { status: 'closed', reason: 'fatal', error } });
    this.#emitError(error);
    this.#settleRun(error);
  }

  /** A retryable failure or an unexpected drop. */
  #connectionLost(error: SyncClientError, _busy?: BusySignal): void {
    this.#log('info', 'connection_lost', { code: error.code });
    this.#teardown(new SyncClientError('CONNECTION_LOST'));
    const gaveUp = new SyncClientError('RECONNECT_FAILED');
    this.#update({ connection: { status: 'closed', reason: 'gave_up', error: gaveUp } });
    this.#emitError(error);
    this.#settleRun(gaveUp);
  }
}

/** Factory alias for apps that prefer functions. */
export function createSyncClient(options: SyncClientOptions): SyncClient {
  return new SyncClient(options);
}
