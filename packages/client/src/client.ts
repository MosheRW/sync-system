import {
  type ErrorMessage,
  type JsonObject,
  type JsonValue,
  MAX_GROUP_ID_INPUT_LENGTH,
  MAX_JSON_DEPTH,
  type ServerMessage,
  type WelcomeMessage,
  checkJson,
} from '@sync-system/protocol';
import { type BusySignal, nextDelay, streakAfterDrop, streakAfterFailure } from './backoff.js';
import { Emitter, ListenerSet } from './emitter.js';
import {
  type ClientErrorCode,
  type RequestKind,
  SyncClientError,
  fromServerError,
  invalidServerMessage,
} from './errors.js';
import {
  buildHello,
  checkHelloOk,
  checkWelcome,
  classifyClose,
  classifyHandshakeError,
} from './handshake.js';
import { type TimerHandle, clearTimer, globalWebSocket, now, setClampedTimeout } from './host.js';
import { jsonByteLength } from './json-size.js';
import { maxInboundChars } from './limits.js';
import { type LogFields, type LogLevel, log } from './logger.js';
import { type ResolvedOptions, type SyncClientOptions, resolveOptions } from './options.js';
import { type RejoinStrategy, memberRejoinByGroupId } from './rejoin.js';
import { type PendingRequest, RequestTracker } from './requests.js';
import type {
  ConnectedInfo,
  ConnectionState,
  CreatedGroup,
  GroupEndedInfo,
  GroupEndedReason,
  GroupState,
  JoinedGroup,
  SyncClientEvents,
  SyncClientSnapshot,
} from './state.js';
import { PositionThrottle } from './throttle.js';
import { type InboundFrame, Transport } from './transport.js';

/** Handshake phase of the current socket. */
type Phase = 'welcome' | 'hello' | 'ready';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface RequestCallbacks {
  resolve(message: ServerMessage): void;
  reject(error: SyncClientError): void;
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

/** Runs local checks; returns the SyncClientError they threw, if any. */
function localError(check: () => void): SyncClientError | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    if (error instanceof SyncClientError) return error;
    throw error;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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
  /** Last time any frame came from the server (M4). */
  #lastInboundAt = 0;
  /** Leader throttle for the current group. */
  #throttle: PositionThrottle | undefined;
  /** One group create/join in flight at a time (L5). */
  #groupRequestInFlight = false;
  #reconnectTimer: TimerHandle | undefined;
  /**
   * Sets the backoff delay. Grows on every failed attempt (fatal ones too)
   * and resets only through the stability rule (H1) or a new client.
   */
  #failureStreak = 0;
  /** Reconnect attempts since the last `connect()` or stable connection, against `maxAttempts` (R2-L5). */
  #runAttempts = 0;
  /** When the current connection reached `connected` (H1). */
  #connectedAt = 0;
  /** Group handling across reconnects (Q1). Item 3 swaps in token rejoin. */
  readonly #rejoin: RejoinStrategy = memberRejoinByGroupId;

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
    this.#runAttempts = 0;
    this.#update({
      connection: { status: 'connecting' },
      group: state.status === 'closed' ? null : this.#snapshot.group,
    });
    this.#openSocket();
    return run.promise;
  }

  /**
   * Stops the client (AC28): closes the socket with 1000, rejects pending
   * requests and `connect()` with `CLOSED`, and cancels every timer and the
   * throttled update. Idempotent and synchronous.
   */
  close(): void {
    if (this.#snapshot.connection.status === 'closed') return;
    const error = new SyncClientError('CLOSED');
    clearTimer(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#teardown(error);
    this.#endGroup('closed');
    this.#update({ connection: { status: 'closed', reason: 'client' } });
    this.#settleRun(error);
  }

  /**
   * Creates a group with this client as leader (AC15). Rejects locally with
   * NOT_CONNECTED, ALREADY_IN_GROUP, REQUEST_IN_PROGRESS, INVALID_PAYLOAD or
   * MESSAGE_TOO_LARGE before anything is sent.
   */
  createGroup(metadata: JsonObject, initialPosition?: JsonValue): Promise<CreatedGroup> {
    const invalid = localError(() => {
      this.#checkGroupRequest();
      if (!isJsonObject(metadata)) throw new SyncClientError('INVALID_PAYLOAD');
      this.#checkPayload('metadata', metadata);
      if (initialPosition !== undefined) this.#checkPayload('position', initialPosition);
    });
    if (invalid) return Promise.reject(invalid);
    const reqId = this.#requests.nextId();
    const message = {
      type: 'group.create' as const,
      reqId,
      metadata,
      ...(initialPosition === undefined ? {} : { position: initialPosition }),
    };
    const result = deferred<CreatedGroup>();
    this.#trackGroupRequest('group.create', reqId, message, {
      resolve: (reply) => {
        if (reply.type !== 'group.created') return;
        this.#startGroup({
          status: 'active',
          groupId: reply.groupId,
          role: 'leader',
          metadata: null,
          hasPosition: initialPosition !== undefined,
          position: initialPosition,
        });
        result.resolve(
          Object.freeze({
            groupId: reply.groupId,
            role: 'leader',
            participantId: reply.participantId,
          }),
        );
      },
      reject: (error) => result.reject(error),
    });
    return result.promise;
  }

  /**
   * Joins a group as member (AC16). Rejects locally with NOT_CONNECTED,
   * ALREADY_IN_GROUP, REQUEST_IN_PROGRESS or INVALID_PAYLOAD, and with the
   * server's code (GROUP_NOT_FOUND, GROUP_FULL, ...) otherwise.
   */
  joinGroup(groupId: string): Promise<JoinedGroup> {
    const invalid = localError(() => {
      this.#checkGroupRequest();
      if (
        typeof groupId !== 'string' ||
        groupId.length === 0 ||
        groupId.length > MAX_GROUP_ID_INPUT_LENGTH
      ) {
        throw new SyncClientError('INVALID_PAYLOAD');
      }
    });
    if (invalid) return Promise.reject(invalid);
    const result = deferred<JoinedGroup>();
    this.#join(groupId, {
      resolve: (joined) => result.resolve(joined),
      reject: (error) => result.reject(error),
    });
    return result.promise;
  }

  /**
   * Sets the leader's position (AC18, AC21). Throws NOT_CONNECTED,
   * NOT_IN_GROUP, NOT_LEADER, INVALID_PAYLOAD or MESSAGE_TOO_LARGE locally,
   * and sends nothing then. Calls faster than the rate limit are coalesced;
   * the latest position is always sent. Server rejections arrive as `error`
   * events.
   */
  updatePosition(position: JsonValue): void {
    if (this.#snapshot.connection.status !== 'connected') {
      throw new SyncClientError('NOT_CONNECTED');
    }
    const group = this.#snapshot.group;
    if (group === null || group.status === 'ended') throw new SyncClientError('NOT_IN_GROUP');
    if (group.status !== 'active' || group.role !== 'leader') {
      throw new SyncClientError('NOT_LEADER');
    }
    this.#checkPayload('position', position);
    this.#update({ group: { ...group, hasPosition: true, position } });
    this.#throttle?.submit(position);
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
  // Groups
  // ---------------------------------------------------------------------------

  /** Local checks for create/join, in the planned order (AC11, L5). */
  #checkGroupRequest(): void {
    if (this.#snapshot.connection.status !== 'connected') {
      throw new SyncClientError('NOT_CONNECTED');
    }
    const group = this.#snapshot.group;
    if (group !== null && group.status !== 'ended') throw new SyncClientError('ALREADY_IN_GROUP');
    if (this.#groupRequestInFlight) throw new SyncClientError('REQUEST_IN_PROGRESS');
  }

  /** JSON check (depth leaves room for the envelope) then size, as the server measures it (AC22). */
  #checkPayload(field: 'metadata' | 'position', value: unknown): void {
    if (checkJson(value, { maxDepth: MAX_JSON_DEPTH - 1 }) !== 'ok') {
      throw new SyncClientError('INVALID_PAYLOAD');
    }
    const limitBytes = this.#info?.limits.maxMessageBytes ?? 0;
    const sizeBytes = jsonByteLength(value);
    if (sizeBytes > limitBytes) {
      throw new SyncClientError('MESSAGE_TOO_LARGE', { details: { field, sizeBytes, limitBytes } });
    }
  }

  /**
   * Sends a create/join and tracks it. The in-flight flag is cleared in the
   * same callbacks that settle the request, so it clears on a reply, an
   * error, a timeout, a drop and `close()` alike (R2-L4).
   */
  #trackGroupRequest(
    kind: 'group.create' | 'group.join',
    reqId: string,
    message: object,
    callbacks: RequestCallbacks,
  ): void {
    this.#groupRequestInFlight = true;
    this.#requests.add(reqId, {
      kind,
      timeoutKind: 'drop',
      timeoutMs: this.#opts.requestTimeoutMs,
      resolve: (reply) => {
        this.#groupRequestInFlight = false;
        callbacks.resolve(reply);
      },
      reject: (error) => {
        this.#groupRequestInFlight = false;
        callbacks.reject(error);
      },
    });
    // A throwing socket is handled as a drop, which rejects the request above.
    this.#send(message);
  }

  #join(
    groupId: string,
    callbacks: { resolve(joined: JoinedGroup): void; reject(error: SyncClientError): void },
  ): void {
    const reqId = this.#requests.nextId();
    this.#trackGroupRequest(
      'group.join',
      reqId,
      { type: 'group.join', reqId, groupId },
      {
        resolve: (reply) => {
          if (reply.type !== 'group.joined') return;
          const joined: JoinedGroup = Object.freeze({
            groupId: reply.groupId,
            role: 'member',
            participantId: reply.participantId,
            metadata: reply.metadata,
            hasPosition: reply.hasPosition,
            ...(reply.hasPosition ? { position: reply.position } : {}),
          });
          this.#startGroup({
            status: 'active',
            groupId: reply.groupId,
            role: 'member',
            metadata: reply.metadata,
            hasPosition: reply.hasPosition,
            position: reply.hasPosition ? reply.position : undefined,
          });
          callbacks.resolve(joined);
        },
        reject: (error) => callbacks.reject(error),
      },
    );
  }

  #startGroup(group: Extract<GroupState, { status: 'active' }>): void {
    this.#throttle?.cancel();
    this.#throttle =
      group.role === 'leader' && this.#info
        ? new PositionThrottle(this.#info.limits.maxLeaderUpdatesPerSecond, (position) =>
            this.#sendPosition(position),
          )
        : undefined;
    this.#update({ group });
  }

  /** Ends an active or rejoining group, stops the throttle and emits `groupEnded` (AC19, AC29). */
  #endGroup(reason: GroupEndedReason, code?: ClientErrorCode): void {
    const group = this.#snapshot.group;
    this.#throttle?.cancel();
    this.#throttle = undefined;
    if (group === null || group.status === 'ended') return;
    const info: GroupEndedInfo = Object.freeze({
      groupId: group.groupId,
      reason,
      ...(code === undefined ? {} : { code }),
    });
    this.#update({ group: { status: 'ended', ...info } });
    this.#events.emit('groupEnded', info);
  }

  #sendPosition(position: JsonValue): void {
    const reqId = this.#requests.nextId();
    this.#requests.add(reqId, {
      kind: 'position.update',
      // Twice the request timeout; drops only on a silent link (M4).
      timeoutKind: 'ack',
      timeoutMs: 2 * this.#opts.requestTimeoutMs,
      position,
      resolve: () => {},
      reject: (error) => this.#onPositionRejected(position, error),
    });
    this.#send({ type: 'position.update', reqId, position });
  }

  /** Server rejections of a position update come through the `error` event (AC23). */
  #onPositionRejected(position: JsonValue, error: SyncClientError): void {
    if (
      error.source === 'client' &&
      (error.code === 'CONNECTION_LOST' || error.code === 'CLOSED')
    ) {
      return;
    }
    this.#emitError(error);
    if (error.code === 'RATE_LIMITED') {
      const details = error.details as { retryAfterMs?: number } | undefined;
      this.#throttle?.rateLimited(position, details?.retryAfterMs);
    }
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
    // Any frame, valid or not, proves the link is alive (M4).
    this.#lastInboundAt = now();
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
    // The backoff is not reset here; see the stability rule in #connectionLost (H1).
    this.#connectedAt = now();
    this.#transport?.setMaxInboundChars(maxInboundChars(limits));
    this.#update({ connection: { status: 'connected', ...info } });
    this.#settleRun(info);
    this.#rejoinGroup();
  }

  /** After each hello.ok: a member gets back into its group, or is told it is not (AC29). */
  #rejoinGroup(): void {
    this.#rejoin.onReady(
      {
        group: this.#snapshot.group,
        join: (groupId, callbacks) => this.#join(groupId, callbacks),
      },
      (outcome) => {
        if (outcome.kind === 'rejoined') {
          this.#log('info', 'group_rejoined');
          this.#events.emit('rejoined', outcome.joined);
        } else if (outcome.kind === 'failed') {
          this.#log('info', 'group_rejoin_failed', { code: outcome.code });
          this.#endGroup('rejoin_failed', outcome.code);
        }
      },
    );
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
      case 'position.updated': {
        const group = this.#snapshot.group;
        if (
          group?.status !== 'active' ||
          group.role !== 'member' ||
          group.groupId !== message.groupId
        ) {
          return;
        }
        this.#update({ group: { ...group, hasPosition: true, position: message.position } });
        this.#events.emit(
          'positionUpdated',
          Object.freeze({ groupId: message.groupId, position: message.position }),
        );
        return;
      }
      case 'group.ended': {
        const group = this.#snapshot.group;
        if (group?.status === 'active' && group.groupId === message.groupId) {
          this.#endGroup('leader_disconnected');
        }
        return;
      }
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

  /**
   * Request timeouts (M4, Q-C). The request was already rejected with
   * REQUEST_TIMEOUT. Create/join drop the socket; a position ack drops it
   * only if nothing came from the server for `requestTimeoutMs`.
   */
  #onRequestTimeout(request: PendingRequest): void {
    this.#log('debug', 'request_timeout', { request: request.kind });
    const silentFor = now() - this.#lastInboundAt;
    if (request.timeoutKind === 'drop' || silentFor >= this.#opts.requestTimeoutMs) {
      this.#connectionLost(new SyncClientError('REQUEST_TIMEOUT', { request: request.kind }));
    }
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
    this.#throttle?.cancel();
    this.#requests.rejectAll(requestError);
  }

  /** A fatal error: closed, no automatic reconnect (AC14). */
  #fail(error: SyncClientError): void {
    this.#log('warn', 'fatal_error', { code: error.code });
    this.#failureStreak = streakAfterFailure(this.#failureStreak);
    this.#teardown(error, error.code);
    const group = this.#snapshot.group;
    this.#endGroup(group?.status === 'rejoining' ? 'rejoin_failed' : 'closed', error.code);
    this.#update({ connection: { status: 'closed', reason: 'fatal', error } });
    this.#emitError(error);
    this.#settleRun(error);
  }

  /**
   * A retryable failure or an unexpected drop (AC26). Every failure grows the
   * streak, timeouts included (M4); busy signals start at a higher streak
   * (M3). A connection that stayed up for `stableAfterMs` resets the streak
   * and the attempt count first (H1, R2-L5).
   */
  #connectionLost(error: SyncClientError, busy?: BusySignal): void {
    this.#log('info', 'connection_lost', { code: error.code });
    const wasConnected = this.#phase === 'ready';
    const group = this.#snapshot.group;
    this.#teardown(new SyncClientError('CONNECTION_LOST'));
    if (wasConnected) {
      const connectedFor = now() - this.#connectedAt;
      if (streakAfterDrop(this.#failureStreak, connectedFor, this.#opts.stableAfterMs) === 0) {
        this.#failureStreak = 0;
        this.#runAttempts = 0;
      }
    }
    this.#failureStreak = streakAfterFailure(this.#failureStreak, busy);
    this.#groupAfterDrop(group);
    if (this.#runAttempts >= this.#opts.maxAttempts) {
      this.#giveUp(error);
      return;
    }
    this.#scheduleRetry(busy);
    this.#emitError(error);
  }

  /**
   * A leader's group ended on the server when its socket closed, so it is
   * marked ended at the drop. A member's group becomes `rejoining`, keeping
   * the last metadata and position (Q1, AC29).
   */
  #groupAfterDrop(group: GroupState | null): void {
    const next = this.#rejoin.onDisconnected(group);
    if (next === group) return;
    if (next?.status === 'ended') {
      this.#endGroup(next.reason, next.code);
      return;
    }
    this.#update({ group: next });
  }

  /** Waits the backoff delay, then opens a new socket (state `reconnecting`). */
  #scheduleRetry(busy?: BusySignal): void {
    const delayMs = nextDelay(
      this.#failureStreak,
      this.#opts,
      this.#opts.random ?? Math.random,
      busy,
    );
    const attempt = this.#runAttempts + 1;
    this.#log('info', 'reconnect_scheduled', { attempt, delayMs });
    this.#update({
      connection: {
        status: 'reconnecting',
        attempt,
        delayMs,
        retryAt: now() + delayMs,
        attempting: false,
      },
    });
    this.#reconnectTimer = setClampedTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#retry();
    }, delayMs);
  }

  #retry(): void {
    const state = this.#snapshot.connection;
    if (state.status !== 'reconnecting') return;
    this.#runAttempts += 1;
    this.#update({ connection: { ...state, attempting: true } });
    this.#openSocket();
  }

  /** `maxAttempts` used up: closed(gave_up) with RECONNECT_FAILED (AC26). */
  #giveUp(lastError: SyncClientError): void {
    const error = new SyncClientError('RECONNECT_FAILED');
    this.#log('warn', 'reconnect_gave_up', { code: lastError.code });
    this.#endGroup('rejoin_failed', error.code);
    this.#update({ connection: { status: 'closed', reason: 'gave_up', error } });
    this.#emitError(lastError);
    this.#emitError(error);
    this.#settleRun(error);
  }
}

/** Factory alias for apps that prefer functions. */
export function createSyncClient(options: SyncClientOptions): SyncClient {
  return new SyncClient(options);
}
