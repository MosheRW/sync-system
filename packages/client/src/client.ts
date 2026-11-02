import {
  type ErrorMessage,
  type JsonObject,
  type JsonValue,
  MAX_GROUP_ID_INPUT_LENGTH,
  MAX_BLOCK_LIST_SIZE,
  MAX_TOKENS_PER_CHECK,
  PARTICIPANT_ID_PATTERN,
  type TokenStatus,
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
import { utf8ByteLength } from './json-size.js';
import { maxInboundChars } from './limits.js';
import { type LogFields, type LogLevel, log } from './logger.js';
import { type ResolvedOptions, type SyncClientOptions, resolveOptions } from './options.js';
import { type RejoinStrategy, tokenRejoin } from './rejoin.js';
import { type PendingRequest, RequestTracker } from './requests.js';
import { type TokenStorage, resolveStorage } from './storage.js';
import { type StoredEntry, TokenStore, storageKey } from './token-store.js';
import type {
  ConnectedInfo,
  ConnectionState,
  CreatedGroup,
  GroupEndedInfo,
  GroupEndedReason,
  GroupState,
  JoinedGroup,
  ResumeOptions,
  ResumedGroup,
  StoredGroupStatus,
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

/** Which replies each request accepts. */
const REPLY_TYPES: Record<RequestKind, readonly ServerMessage['type'][]> = {
  hello: ['hello.ok'],
  'group.create': ['group.created'],
  'group.join': ['group.joined'],
  'position.update': ['position.ack'],
  'group.resume': ['group.resumed', 'group.joined', 'group.waiting'],
  'tokens.check': ['tokens.result'],
  'group.end': ['group.ended'],
  'group.leave': ['group.left'],
  'blocklist.set': ['blocklist.ack'],
};

/** Statuses after which a stored token is useless and deleted (#5 AC31). */
const DEAD_STATUSES: ReadonlySet<TokenStatus> = new Set<TokenStatus>([
  'ended',
  'expired',
  'invalid',
  'blocked',
]);

/** Server answers that mean a stored token is useless: it is deleted (#5 AC31). */
const TOKEN_DEAD_CODES: ReadonlySet<ClientErrorCode> = new Set<ClientErrorCode>([
  'TOKEN_INVALID',
  'TOKEN_EXPIRED',
  'GROUP_ENDED',
  'PARTICIPANT_BLOCKED',
]);

interface ResumeCallbacks {
  resolve(resumed: ResumedGroup): void;
  reject(error: SyncClientError): void;
}

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
  /** Leader throttle for the current group; holds positions as checked JSON text. */
  #throttle: PositionThrottle<string> | undefined;
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
  /** When the last socket was constructed (R2-L6). */
  #lastSocketOpenAt: number | undefined;
  /**
   * Lifecycle generation, bumped by `close()` and by `connect()` starting a
   * new run. App callbacks run synchronously inside internal flows (state,
   * subscribers, groupEnded, error), and one of them may call `close()` or
   * `connect()`. Each flow keeps the value it started with and returns as
   * soon as it changed after an emit, so it never reopens a socket, starts a
   * timer or overwrites the state the app just set (AC28).
   */
  #generation = 0;
  /** Resolved on first use (after hello.ok), never at construction (#5 AC32). */
  #storage: TokenStorage | undefined;
  /** Tokens for the current server and app (#5 AC31, AC33). */
  #tokens: TokenStore | undefined;
  /** One checkTokens() at a time (#5 AC37). */
  #checkInFlight = false;
  /** Group handling across reconnects: token rejoin (#5 AC35). */
  readonly #rejoin: RejoinStrategy = tokenRejoin;

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
   *
   * `connect()` never resets the backoff (M5): after `closed(fatal)`,
   * `closed(gave_up)` or recent failures it first waits the next backoff
   * delay, so an app that reconnects on every `closed` cannot hammer the
   * server. Two sockets are never opened less than `initialDelayMs` apart
   * through `close()` + `connect()` (R2-L6).
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
    const generation = ++this.#generation;
    const group = state.status === 'closed' ? null : this.#snapshot.group;
    const afterFailure =
      state.status === 'closed' && (state.reason === 'fatal' || state.reason === 'gave_up');
    if (afterFailure || this.#failureStreak > 0) {
      this.#update({ group });
      if (generation !== this.#generation) return run.promise;
      this.#scheduleRetry(undefined, this.#failureStreak + 1);
      return run.promise;
    }
    const sinceLastOpen =
      this.#lastSocketOpenAt === undefined ? Infinity : now() - this.#lastSocketOpenAt;
    const gap = this.#opts.initialDelayMs - sinceLastOpen;
    if (gap > 0) {
      // Registered before listeners run, so a close() from one cancels it.
      this.#reconnectTimer = setClampedTimeout(() => {
        this.#reconnectTimer = undefined;
        this.#openSocket();
      }, gap);
    }
    this.#update({ connection: { status: 'connecting' }, group });
    if (gap <= 0 && generation === this.#generation) this.#openSocket();
    return run.promise;
  }

  /**
   * Stops the client (AC28): closes the socket with 1000, rejects pending
   * requests and `connect()` with `CLOSED`, and cancels every timer and the
   * throttled update. Idempotent and synchronous.
   */
  close(): void {
    if (this.#snapshot.connection.status === 'closed') return;
    const generation = ++this.#generation;
    const error = new SyncClientError('CLOSED');
    clearTimer(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    // A connection that stayed up long enough counts as stable here too (H1).
    if (this.#phase === 'ready' && now() - this.#connectedAt >= this.#opts.stableAfterMs) {
      this.#failureStreak = 0;
    }
    this.#teardown(error);
    // Tokens are kept on close() (resume later); a pending position is written.
    void this.#tokens?.flush();
    this.#endGroup('closed');
    // A groupEnded listener called close() or connect() itself.
    if (generation !== this.#generation) return;
    // Detached before the closed state is announced: a listener's connect()
    // starts its own run and never gets this run's CLOSED.
    const run = this.#takeRun();
    this.#update({ connection: { status: 'closed', reason: 'client' } });
    run?.reject(error);
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
        void this.#tokens?.saveToken(reply.token, {
          metadata,
          hasPosition: initialPosition !== undefined,
          ...(initialPosition === undefined ? {} : { position: initialPosition }),
          blockList: [],
        });
        this.#startGroup({
          status: 'active',
          groupId: reply.groupId,
          role: 'leader',
          metadata,
          hasPosition: initialPosition !== undefined,
          position: initialPosition,
          leaderOnline: true,
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
   * Asks the server about every stored token for this server and app (#5
   * AC37), up to 20, and resolves with `{ groupId, role, status }` per token.
   * Tokens reported `ended`, `expired`, `invalid` or `blocked` are deleted;
   * re-signed tokens (secret rotation) are stored. Resolves `[]` without
   * sending anything when nothing is stored. Never called automatically.
   * Rejects with NOT_CONNECTED, REQUEST_IN_PROGRESS or a server error
   * (RATE_LIMITED: 10 checks per minute).
   */
  checkTokens(): Promise<readonly StoredGroupStatus[]> {
    if (this.#snapshot.connection.status !== 'connected' || this.#tokens === undefined) {
      return Promise.reject(new SyncClientError('NOT_CONNECTED'));
    }
    if (this.#checkInFlight) return Promise.reject(new SyncClientError('REQUEST_IN_PROGRESS'));
    this.#checkInFlight = true;
    const store = this.#tokens;
    const generation = this.#generation;
    const transport = this.#transport;
    const result = deferred<readonly StoredGroupStatus[]>();
    void store.load().then((all) => {
      if (
        generation !== this.#generation ||
        transport !== this.#transport ||
        this.#phase !== 'ready'
      ) {
        this.#checkInFlight = false;
        result.reject(new SyncClientError('CONNECTION_LOST', { request: 'tokens.check' }));
        return;
      }
      const entries = all.slice(0, MAX_TOKENS_PER_CHECK);
      if (entries.length === 0) {
        this.#checkInFlight = false;
        result.resolve(Object.freeze([]));
        return;
      }
      const reqId = this.#requests.nextId();
      this.#requests.add(reqId, {
        kind: 'tokens.check',
        timeoutKind: 'ack',
        timeoutMs: this.#opts.requestTimeoutMs,
        resolve: (reply) => {
          this.#checkInFlight = false;
          if (reply.type !== 'tokens.result' || reply.results.length !== entries.length) {
            result.reject(invalidServerMessage(['results: wrong_length'], 'tokens.check'));
            return;
          }
          const statuses = entries.map((entry, index) => {
            const { status, token } = reply.results[index]!;
            if (token !== undefined && !DEAD_STATUSES.has(status)) void store.saveToken(token);
            return Object.freeze({ groupId: entry.claims.gid, role: entry.claims.role, status });
          });
          const dead = statuses.filter((s) => DEAD_STATUSES.has(s.status)).map((s) => s.groupId);
          if (dead.length > 0) void store.remove(dead);
          this.#log('info', 'tokens_checked', { count: statuses.length });
          result.resolve(Object.freeze(statuses));
        },
        reject: (error) => {
          this.#checkInFlight = false;
          result.reject(error);
        },
      });
      this.#send({ type: 'tokens.check', reqId, tokens: entries.map((entry) => entry.token) });
    });
    return result.promise;
  }

  /**
   * Resumes a stored group (#5 AC38): a leader returns to (or recreates) its
   * group with its saved metadata, latest position and block list, which
   * `options` may override; a member rejoins, or waits until its leader
   * recreates the group (`status: 'waiting'`). Rejects locally with
   * NOT_CONNECTED, ALREADY_IN_GROUP, REQUEST_IN_PROGRESS, INVALID_PAYLOAD,
   * MESSAGE_TOO_LARGE or TOKEN_NOT_FOUND, and with the server's code
   * otherwise (TOKEN_INVALID, TOKEN_EXPIRED, GROUP_ENDED and
   * PARTICIPANT_BLOCKED also delete the stored token).
   */
  resumeGroup(groupId: string, options?: ResumeOptions): Promise<ResumedGroup> {
    const invalid = localError(() => {
      this.#checkGroupRequest();
      if (
        typeof groupId !== 'string' ||
        groupId.length === 0 ||
        groupId.length > MAX_GROUP_ID_INPUT_LENGTH
      ) {
        throw new SyncClientError('INVALID_PAYLOAD');
      }
      if (options !== undefined) {
        if (typeof options !== 'object' || options === null) {
          throw new SyncClientError('INVALID_PAYLOAD');
        }
        if (options.metadata !== undefined) {
          if (!isJsonObject(options.metadata)) throw new SyncClientError('INVALID_PAYLOAD');
          this.#checkPayload('metadata', options.metadata);
        }
        if (options.position !== undefined) this.#checkPayload('position', options.position);
      }
    });
    if (invalid) return Promise.reject(invalid);
    const result = deferred<ResumedGroup>();
    this.#resume(groupId, options, {
      resolve: (resumed) => result.resolve(resumed),
      reject: (error) => result.reject(error),
    });
    return result.promise;
  }

  /**
   * Ends the group for everyone (#5 AC29). Leader only: rejects locally with
   * NOT_CONNECTED, NOT_IN_GROUP or NOT_LEADER. On success the token and
   * recovery data are deleted and the group is `ended` (`ended_by_leader`).
   */
  endGroup(): Promise<void> {
    const invalid = localError(() => {
      const group = this.#checkInGroup();
      if (group.status === 'waiting' || group.role !== 'leader') {
        throw new SyncClientError('NOT_LEADER');
      }
    });
    if (invalid) return Promise.reject(invalid);
    return this.#leaveRequest('group.end', 'ended_by_leader');
  }

  /**
   * Leaves the group, or stops waiting for it (#5 AC30). Members only: a
   * leader gets LEADER_CANNOT_LEAVE (it ends the group instead). Also
   * NOT_CONNECTED and NOT_IN_GROUP locally. On success the token is deleted
   * and the group is `ended` (`left`). Leaving does not block.
   */
  leaveGroup(): Promise<void> {
    const invalid = localError(() => {
      const group = this.#checkInGroup();
      if (group.status === 'active' && group.role === 'leader') {
        throw new SyncClientError('LEADER_CANNOT_LEAVE');
      }
    });
    if (invalid) return Promise.reject(invalid);
    return this.#leaveRequest('group.leave', 'left');
  }

  /**
   * A leader group's stored block list (#5 AC34). Rejects with
   * TOKEN_NOT_FOUND unless a leader token is stored for the group, and with
   * NOT_CONNECTED before the first `hello.ok`.
   */
  async getBlockList(groupId: string): Promise<readonly string[]> {
    const store = this.#tokens;
    if (store === undefined) throw new SyncClientError('NOT_CONNECTED');
    const entry = await store.findFresh(groupId);
    if (entry?.claims.role !== 'leader' || entry.recovery === undefined) {
      throw new SyncClientError('TOKEN_NOT_FOUND');
    }
    return Object.freeze([...entry.recovery.blockList]);
  }

  /**
   * Adds participant IDs to a leader group's block list and resolves with the
   * new list (#5 AC34). While the group is active and led by this client the
   * full list is sent (blocklist.set) and the call resolves on the server's
   * ack: blocked members are removed at once. Otherwise the list is only
   * stored and goes with the next resume. Rejects with INVALID_PAYLOAD,
   * BLOCK_LIST_FULL (`details.limit`: 256), TOKEN_NOT_FOUND or NOT_CONNECTED.
   */
  addToBlockList(groupId: string, participantIds: readonly string[]): Promise<readonly string[]> {
    return this.#editBlockList(groupId, participantIds, (current, ids) => [...current, ...ids]);
  }

  /** Removes participant IDs from a leader group's block list (#5 AC34). Same rules as add. */
  removeFromBlockList(
    groupId: string,
    participantIds: readonly string[],
  ): Promise<readonly string[]> {
    return this.#editBlockList(groupId, participantIds, (current, ids) =>
      current.filter((id) => !ids.includes(id)),
    );
  }

  /**
   * Deletes the stored token and recovery data of one group, locally, with
   * no server call (#5 M6). Uses the namespace of the last `hello.ok`, or
   * `namespace` if given; rejects with NOT_CONNECTED when neither is known.
   */
  forgetGroup(groupId: string, namespace?: string): Promise<void> {
    const store = this.#storeFor(namespace);
    if (store === undefined) return Promise.reject(new SyncClientError('NOT_CONNECTED'));
    return store.remove([groupId]);
  }

  /**
   * Deletes every stored token for this server and app, and the storage key
   * itself (#5 M6): call it on "log out" or on a shared device. Same
   * namespace rule as `forgetGroup`.
   */
  forgetAllGroups(namespace?: string): Promise<void> {
    const store = this.#storeFor(namespace);
    if (store === undefined) return Promise.reject(new SyncClientError('NOT_CONNECTED'));
    return store.removeAll();
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
    // Serialized once: the checked text is what goes out, even if the app
    // mutates `position` while the update waits in the throttle.
    const json = this.#checkPayload('position', position);
    // Recovery data: the latest position the leader sent (#5 AC34).
    this.#tokens?.savePosition(group.groupId, position);
    this.#update({ group: { ...group, hasPosition: true, position } });
    this.#throttle?.submit(json);
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

  /**
   * Detaches the pending `connect()` run, if any. Called before the state
   * change that ends the run is announced, so a `connect()` from a listener
   * creates a new run, and the caller settles exactly the run it detached.
   */
  #takeRun(): Deferred<ConnectedInfo> | undefined {
    const run = this.#run;
    this.#run = undefined;
    return run;
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

  /** Local checks for end/leave: connected and in an active or waiting group. */
  #checkInGroup(): Extract<GroupState, { status: 'active' | 'waiting' }> {
    if (this.#snapshot.connection.status !== 'connected') {
      throw new SyncClientError('NOT_CONNECTED');
    }
    const group = this.#snapshot.group;
    if (group === null || (group.status !== 'active' && group.status !== 'waiting')) {
      throw new SyncClientError('NOT_IN_GROUP');
    }
    if (this.#groupRequestInFlight) throw new SyncClientError('REQUEST_IN_PROGRESS');
    return group;
  }

  /** Sends group.end or group.leave; on success deletes the token and ends the group. */
  #leaveRequest(kind: 'group.end' | 'group.leave', reason: GroupEndedReason): Promise<void> {
    const group = this.#snapshot.group as Extract<GroupState, { status: 'active' | 'waiting' }>;
    const groupId = group.groupId;
    const reqId = this.#requests.nextId();
    const result = deferred<undefined>();
    this.#groupRequestInFlight = true;
    this.#requests.add(reqId, {
      kind,
      timeoutKind: 'drop',
      timeoutMs: this.#opts.requestTimeoutMs,
      resolve: () => {
        this.#groupRequestInFlight = false;
        void this.#tokens?.remove([groupId]);
        const current = this.#snapshot.group;
        if (current !== null && current.status !== 'ended' && current.groupId === groupId) {
          this.#endGroup(reason);
        }
        result.resolve(undefined);
      },
      reject: (error) => {
        this.#groupRequestInFlight = false;
        result.reject(error);
      },
    });
    this.#send({ type: kind, reqId });
    return result.promise;
  }

  async #editBlockList(
    groupId: string,
    participantIds: readonly string[],
    change: (current: readonly string[], ids: readonly string[]) => readonly string[],
  ): Promise<readonly string[]> {
    const raw: unknown = participantIds;
    if (
      !Array.isArray(raw) ||
      !raw.every((id): id is string => typeof id === 'string' && PARTICIPANT_ID_PATTERN.test(id))
    ) {
      throw new SyncClientError('INVALID_PAYLOAD');
    }
    const store = this.#tokens;
    if (store === undefined) throw new SyncClientError('NOT_CONNECTED');
    const ids: string[] = [...raw];
    const result = await store.editBlockList(groupId, (current) => change(current, ids));
    if (!result.ok) {
      throw result.reason === 'full'
        ? new SyncClientError('BLOCK_LIST_FULL', { details: { limit: MAX_BLOCK_LIST_SIZE } })
        : new SyncClientError('TOKEN_NOT_FOUND');
    }
    const blockList = Object.freeze([...result.blockList]);
    const group = this.#snapshot.group;
    const live =
      this.#snapshot.connection.status === 'connected' &&
      group?.status === 'active' &&
      group.role === 'leader' &&
      group.groupId === groupId;
    if (!live) return blockList;
    await this.#sendBlockList(blockList);
    return blockList;
  }

  /** Sends the full block list to the server and resolves on blocklist.ack (#5 AC26). */
  #sendBlockList(blockList: readonly string[]): Promise<void> {
    const reqId = this.#requests.nextId();
    const result = deferred<undefined>();
    this.#requests.add(reqId, {
      kind: 'blocklist.set',
      timeoutKind: 'ack',
      timeoutMs: this.#opts.requestTimeoutMs,
      resolve: () => result.resolve(undefined),
      reject: (error) => result.reject(error),
    });
    this.#send({ type: 'blocklist.set', reqId, blockList: [...blockList] });
    this.#log('debug', 'block_list_sent', { count: blockList.length });
    return result.promise;
  }

  /** The token store for `namespace` (or the current one), without a connection. */
  #storeFor(namespace: string | undefined): TokenStore | undefined {
    if (namespace === undefined) return this.#tokens;
    const log = (level: LogLevel, event: string, fields?: LogFields) =>
      this.#log(level, event, fields);
    if (this.#tokens?.key === storageKey(namespace, this.#opts.storageHost)) return this.#tokens;
    this.#storage ??= resolveStorage(this.#opts.storage, log);
    return new TokenStore(this.#storage, namespace, this.#opts.storageHost, log);
  }

  /**
   * JSON check (depth leaves room for the envelope) then size, as the server
   * measures it (AC22). Returns the JSON text that was measured.
   */
  #checkPayload(field: 'metadata' | 'position', value: unknown): string {
    if (checkJson(value, { maxDepth: MAX_JSON_DEPTH - 1 }) !== 'ok') {
      throw new SyncClientError('INVALID_PAYLOAD');
    }
    let json: unknown;
    try {
      json = JSON.stringify(value);
    } catch {
      // A toJSON or getter that throws, or one that returns a BigInt.
      throw new SyncClientError('INVALID_PAYLOAD');
    }
    if (typeof json !== 'string') throw new SyncClientError('INVALID_PAYLOAD');
    const limitBytes = this.#info?.limits.maxMessageBytes ?? 0;
    const sizeBytes = utf8ByteLength(json);
    if (sizeBytes > limitBytes) {
      throw new SyncClientError('MESSAGE_TOO_LARGE', { details: { field, sizeBytes, limitBytes } });
    }
    return json;
  }

  /**
   * Sends a create/join and tracks it. The in-flight flag is cleared in the
   * same callbacks that settle the request, so it clears on a reply, an
   * error, a timeout, a drop and `close()` alike (R2-L4).
   */
  #trackGroupRequest(
    kind: 'group.create' | 'group.join' | 'group.resume',
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
          void this.#tokens?.saveToken(reply.token);
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
            leaderOnline: reply.leaderOnline,
          });
          callbacks.resolve(joined);
        },
        reject: (error) => callbacks.reject(error),
      },
    );
  }

  #startGroup(group: Extract<GroupState, { status: 'active' }>): void {
    this.#throttle?.cancel();
    this.#throttle = undefined;
    if (group.role === 'leader' && this.#info) {
      const throttle: PositionThrottle<string> = new PositionThrottle<string>(
        this.#info.limits.maxLeaderUpdatesPerSecond,
        (json, generation) =>
          this.#sendPosition(json, (retryAfterMs) => {
            // A rejection is re-queued only by the throttle that sent it.
            if (this.#throttle === throttle) throttle.rateLimited(generation, retryAfterMs);
          }),
      );
      this.#throttle = throttle;
    }
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

  /** Sends a position as the exact JSON text `updatePosition` checked. */
  #sendPosition(json: string, onRateLimited: (retryAfterMs: number | undefined) => void): void {
    const reqId = this.#requests.nextId();
    this.#requests.add(reqId, {
      kind: 'position.update',
      // Twice the request timeout; drops only on a silent link (M4).
      timeoutKind: 'ack',
      timeoutMs: 2 * this.#opts.requestTimeoutMs,
      resolve: () => {},
      reject: (error) => this.#onPositionRejected(error, onRateLimited),
    });
    // reqId is a client-made `c<n>`; JSON.stringify quotes it all the same.
    const text = `{"type":"position.update","reqId":${JSON.stringify(reqId)},"position":${json}}`;
    this.#transport?.sendText(text);
  }

  /** Server rejections of a position update come through the `error` event (AC23). */
  #onPositionRejected(
    error: SyncClientError,
    onRateLimited: (retryAfterMs: number | undefined) => void,
  ): void {
    if (
      error.source === 'client' &&
      (error.code === 'CONNECTION_LOST' || error.code === 'CLOSED')
    ) {
      return;
    }
    this.#emitError(error);
    if (error.code === 'RATE_LIMITED') {
      const details = error.details as { retryAfterMs?: number } | undefined;
      onRateLimited(details?.retryAfterMs);
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
    this.#lastSocketOpenAt = now();
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
    const { maxGroupSize, maxLeaderUpdatesPerSecond, maxMessageBytes, maxSessionMinutes } =
      message.limits;
    const limits = Object.freeze({
      maxGroupSize,
      maxLeaderUpdatesPerSecond,
      maxMessageBytes,
      maxSessionMinutes,
    });
    const info: ConnectedInfo = Object.freeze({
      participantId: message.participantId,
      namespace: message.namespace,
      limits,
    });
    this.#info = info;
    this.#phase = 'ready';
    // The backoff is not reset here; see the stability rule in #connectionLost (H1).
    this.#connectedAt = now();
    this.#transport?.setMaxInboundChars(maxInboundChars(limits));
    this.#openTokenStore(message.namespace, maxSessionMinutes);
    const generation = this.#generation;
    const run = this.#takeRun();
    this.#update({ connection: { status: 'connected', ...info } });
    run?.resolve(info);
    if (generation !== this.#generation) return;
    this.#rejoinGroup();
  }

  /**
   * The token store for this server and app, keyed by the namespace from
   * hello.ok and the URL host (#5 AC33). Storage is resolved here, on first
   * use. The stored document is loaded (and pruned) right away.
   */
  #openTokenStore(namespace: string, maxSessionMinutes: number): void {
    const log = (level: LogLevel, event: string, fields?: LogFields) =>
      this.#log(level, event, fields);
    const key = storageKey(namespace, this.#opts.storageHost);
    if (this.#tokens?.key === key) {
      this.#tokens.setMaxSessionMinutes(maxSessionMinutes);
    } else {
      this.#storage ??= resolveStorage(this.#opts.storage, log);
      this.#tokens = new TokenStore(
        this.#storage,
        namespace,
        this.#opts.storageHost,
        log,
        maxSessionMinutes,
      );
    }
    void this.#tokens.load();
  }

  /** After each hello.ok: a dropped group is resumed with its stored token (#5 AC35). */
  #rejoinGroup(): void {
    this.#rejoin.onReady(
      {
        group: this.#snapshot.group,
        resume: (groupId, callbacks) => this.#resume(groupId, undefined, callbacks),
      },
      (outcome) => {
        if (outcome.kind === 'rejoined') {
          this.#log('info', 'group_rejoined', { role: outcome.resumed.role });
          this.#events.emit('rejoined', outcome.resumed);
        } else if (outcome.kind === 'waiting') {
          this.#log('info', 'group_waiting');
        } else if (outcome.kind === 'failed') {
          this.#log('info', 'group_rejoin_failed', { code: outcome.code });
          this.#endGroup('rejoin_failed', outcome.code);
        }
      },
    );
  }

  /**
   * Sends group.resume with the stored token for `groupId` (#5 AC35, AC38).
   * The token and recovery data are read from storage first (another tab
   * may have changed the block list, L5). After that await, the lifecycle
   * generation and the transport are checked again, so a close() or
   * connect() meanwhile never sends on a stale socket. A leader sends its
   * saved metadata, latest position and block list (overridable).
   */
  #resume(groupId: string, overrides: ResumeOptions | undefined, callbacks: ResumeCallbacks): void {
    const store = this.#tokens;
    if (store === undefined) {
      callbacks.reject(new SyncClientError('TOKEN_NOT_FOUND', { request: 'group.resume' }));
      return;
    }
    const generation = this.#generation;
    const transport = this.#transport;
    // Reserved while storage is read, so a second group request waits.
    this.#groupRequestInFlight = true;
    void store.findFresh(groupId).then((entry) => {
      this.#groupRequestInFlight = false;
      if (
        generation !== this.#generation ||
        transport !== this.#transport ||
        this.#phase !== 'ready'
      ) {
        callbacks.reject(new SyncClientError('CONNECTION_LOST', { request: 'group.resume' }));
        return;
      }
      if (entry === undefined) {
        callbacks.reject(new SyncClientError('TOKEN_NOT_FOUND', { request: 'group.resume' }));
        return;
      }
      const reqId = this.#requests.nextId();
      const recovery = entry.recovery;
      const leader = entry.claims.role === 'leader';
      const metadata = overrides?.metadata ?? recovery?.metadata;
      const hasPosition = overrides?.position !== undefined || recovery?.hasPosition === true;
      const position = overrides?.position !== undefined ? overrides.position : recovery?.position;
      const message = {
        type: 'group.resume' as const,
        reqId,
        token: entry.token,
        ...(leader && metadata !== undefined ? { metadata } : {}),
        ...(leader && hasPosition ? { position } : {}),
        ...(leader && recovery !== undefined ? { blockList: [...recovery.blockList] } : {}),
      };
      this.#trackGroupRequest('group.resume', reqId, message, {
        resolve: (reply) => this.#onResumed(entry, reply, callbacks),
        reject: (error) => {
          if (error.source === 'server' && TOKEN_DEAD_CODES.has(error.code)) {
            void store.remove([groupId]);
          }
          callbacks.reject(error);
        },
      });
    });
  }

  /** Applies a group.resume reply: active leader, active member, or waiting member. */
  #onResumed(entry: StoredEntry, reply: ServerMessage, callbacks: ResumeCallbacks): void {
    const groupId = entry.claims.gid;
    if (reply.type === 'group.resumed') {
      // The server's metadata and position win (Q14) and become the recovery data.
      void this.#tokens?.saveToken(reply.token, {
        metadata: reply.metadata,
        hasPosition: reply.hasPosition,
        ...(reply.hasPosition ? { position: reply.position } : {}),
        blockList: entry.recovery?.blockList ?? [],
      });
      this.#startGroup({
        status: 'active',
        groupId,
        role: 'leader',
        metadata: reply.metadata,
        hasPosition: reply.hasPosition,
        position: reply.hasPosition ? reply.position : undefined,
        leaderOnline: true,
      });
      this.#log('info', 'group_resumed', { role: 'leader', recreated: reply.recreated });
      callbacks.resolve(
        Object.freeze({
          groupId,
          role: 'leader',
          participantId: reply.participantId,
          status: 'active',
          recreated: reply.recreated,
          leaderOnline: true,
          metadata: reply.metadata,
          hasPosition: reply.hasPosition,
          ...(reply.hasPosition ? { position: reply.position } : {}),
        }),
      );
      return;
    }
    if (reply.type === 'group.joined') {
      callbacks.resolve(this.#admitted(reply, false));
      return;
    }
    if (reply.type === 'group.waiting') {
      this.#throttle?.cancel();
      this.#throttle = undefined;
      this.#update({ group: { status: 'waiting', groupId, role: 'member' } });
      this.#log('info', 'group_waiting');
      callbacks.resolve(
        Object.freeze({
          groupId,
          role: 'member',
          participantId: entry.claims.pid,
          status: 'waiting',
          recreated: false,
          leaderOnline: false,
          hasPosition: false,
        }),
      );
    }
  }

  /** A member is (back) in its group: token stored, group active (#5 AC17, AC25). */
  #admitted(
    reply: Extract<ServerMessage, { type: 'group.joined' }>,
    recreated: boolean,
  ): ResumedGroup {
    void this.#tokens?.saveToken(reply.token);
    this.#startGroup({
      status: 'active',
      groupId: reply.groupId,
      role: 'member',
      metadata: reply.metadata,
      hasPosition: reply.hasPosition,
      position: reply.hasPosition ? reply.position : undefined,
      leaderOnline: reply.leaderOnline,
    });
    this.#log('info', 'group_resumed', { role: 'member', recreated });
    return Object.freeze({
      groupId: reply.groupId,
      role: 'member',
      participantId: reply.participantId,
      status: 'active',
      recreated,
      leaderOnline: reply.leaderOnline,
      metadata: reply.metadata,
      hasPosition: reply.hasPosition,
      ...(reply.hasPosition ? { position: reply.position } : {}),
    });
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
      case 'group.joined':
        if (message.reqId === undefined) {
          this.#onParkedAdmission(message);
          return;
        }
        this.#onReply(message);
        return;
      case 'group.created':
      case 'group.resumed':
      case 'group.waiting':
      case 'group.left':
      case 'tokens.result':
      case 'blocklist.ack':
      case 'position.ack':
        this.#onReply(message);
        return;
      case 'leader.offline':
      case 'leader.online': {
        const group = this.#snapshot.group;
        if (group?.status !== 'active' || group.groupId !== message.groupId) return;
        const online = message.type === 'leader.online';
        if (group.leaderOnline === online) return;
        this.#update({ group: { ...group, leaderOnline: online } });
        this.#log('info', 'leader_status', { online });
        this.#events.emit('leaderStatus', Object.freeze({ groupId: group.groupId, online }));
        return;
      }
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
      case 'token.refreshed':
        // A newer leader token replaces the stored one (#5 AC12, AC31).
        void this.#tokens?.saveToken(message.token);
        return;
      case 'group.ended': {
        // The leader's own group.end reply.
        if (message.reqId !== undefined && this.#requests.get(message.reqId) !== undefined) {
          this.#onReply(message);
          return;
        }
        const group = this.#snapshot.group;
        if (group === null || group.status === 'ended' || group.groupId !== message.groupId) {
          return;
        }
        // `replaced`: another tab or device holds the same identity now, so
        // the token is kept (Q-C), and the group is not resumed (L6).
        if (message.reason !== 'replaced') void this.#tokens?.remove([message.groupId]);
        this.#endGroup(message.reason);
        return;
      }
    }
  }

  #onReply(message: Extract<ServerMessage, { reqId?: string }>): void {
    if (message.reqId === undefined) return;
    // Unknown reqIds are ignored: a late ack after an ack timeout is harmless (M4).
    const request = this.#requests.take(message.reqId);
    if (request === undefined) return;
    if (!REPLY_TYPES[request.kind].includes(message.type)) {
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
    // While waiting, an error without reqId is about the parked group (#5 AC25).
    const group = this.#snapshot.group;
    if (
      message.reqId === undefined &&
      group?.status === 'waiting' &&
      (message.code === 'PARTICIPANT_BLOCKED' || message.code === 'GROUP_FULL')
    ) {
      if (message.code === 'PARTICIPANT_BLOCKED') void this.#tokens?.remove([group.groupId]);
      this.#endGroup('rejoin_failed', message.code);
      return;
    }
    this.#emitError(fromServerError(message));
  }

  /** The leader recreated the group this member waited for (#5 AC25). */
  #onParkedAdmission(message: Extract<ServerMessage, { type: 'group.joined' }>): void {
    const group = this.#snapshot.group;
    if (group?.status !== 'waiting' || group.groupId !== message.groupId) return;
    const resumed = this.#admitted(message, true);
    this.#events.emit('rejoined', resumed);
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
    const generation = this.#generation;
    this.#log('warn', 'fatal_error', { code: error.code });
    this.#failureStreak = streakAfterFailure(this.#failureStreak);
    this.#teardown(error, error.code);
    const group = this.#snapshot.group;
    this.#endGroup(group?.status === 'rejoining' ? 'rejoin_failed' : 'closed', error.code);
    if (generation !== this.#generation) return;
    const run = this.#takeRun();
    this.#update({ connection: { status: 'closed', reason: 'fatal', error } });
    run?.reject(error);
    // A closed listener started a new run: this failure is not reported as its error.
    if (generation !== this.#generation) return;
    this.#emitError(error);
  }

  /**
   * A retryable failure or an unexpected drop (AC26). Every failure grows the
   * streak, timeouts included (M4); busy signals start at a higher streak
   * (M3). A connection that stayed up for `stableAfterMs` resets the streak
   * and the attempt count first (H1, R2-L5).
   */
  #connectionLost(error: SyncClientError, busy?: BusySignal): void {
    const generation = this.#generation;
    this.#log('info', 'connection_lost', { code: error.code });
    const wasConnected = this.#phase === 'ready';
    const group = this.#snapshot.group;
    this.#teardown(new SyncClientError('CONNECTION_LOST'));
    if (generation !== this.#generation) return;
    if (wasConnected) {
      const connectedFor = now() - this.#connectedAt;
      if (streakAfterDrop(this.#failureStreak, connectedFor, this.#opts.stableAfterMs) === 0) {
        this.#failureStreak = 0;
        this.#runAttempts = 0;
      }
    }
    this.#failureStreak = streakAfterFailure(this.#failureStreak, busy);
    // Listeners may call close() or connect() from here on (AC28).
    this.#groupAfterDrop(group);
    if (generation !== this.#generation) return;
    if (this.#runAttempts >= this.#opts.maxAttempts) {
      this.#giveUp(error);
      return;
    }
    this.#scheduleRetry(busy);
    if (generation !== this.#generation) return;
    this.#emitError(error);
  }

  /**
   * After an unexpected drop the group becomes `rejoining` (leader or
   * member), keeping the last metadata and position, and a pending position
   * save is written (#5 AC35).
   */
  #groupAfterDrop(group: GroupState | null): void {
    void this.#tokens?.flush();
    const next = this.#rejoin.onDisconnected(group);
    if (next === group) return;
    if (next?.status === 'ended') {
      this.#endGroup(next.reason, next.code);
      return;
    }
    this.#update({ group: next });
  }

  /**
   * Waits the backoff delay for `streak`, then opens a new socket (state
   * `reconnecting`). The timer is registered before listeners hear about the
   * new state, so a `close()` from one of them cancels it.
   */
  #scheduleRetry(busy?: BusySignal, streak = this.#failureStreak): void {
    const delayMs = nextDelay(streak, this.#opts, this.#opts.random ?? Math.random, busy);
    const attempt = this.#runAttempts + 1;
    this.#log('info', 'reconnect_scheduled', { attempt, delayMs });
    clearTimer(this.#reconnectTimer);
    this.#reconnectTimer = setClampedTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#retry();
    }, delayMs);
    this.#update({
      connection: {
        status: 'reconnecting',
        attempt,
        delayMs,
        retryAt: now() + delayMs,
        attempting: false,
      },
    });
  }

  #retry(): void {
    const state = this.#snapshot.connection;
    if (state.status !== 'reconnecting') return;
    const generation = this.#generation;
    this.#runAttempts += 1;
    this.#update({ connection: { ...state, attempting: true } });
    if (generation !== this.#generation) return;
    this.#openSocket();
  }

  /** `maxAttempts` used up: closed(gave_up) with RECONNECT_FAILED (AC26). */
  #giveUp(lastError: SyncClientError): void {
    const generation = this.#generation;
    const error = new SyncClientError('RECONNECT_FAILED');
    this.#log('warn', 'reconnect_gave_up', { code: lastError.code });
    this.#endGroup('rejoin_failed', error.code);
    if (generation !== this.#generation) return;
    const run = this.#takeRun();
    this.#update({ connection: { status: 'closed', reason: 'gave_up', error } });
    run?.reject(error);
    if (generation !== this.#generation) return;
    this.#emitError(lastError);
    if (generation !== this.#generation) return;
    this.#emitError(error);
  }
}

/** Factory alias for apps that prefer functions. */
export function createSyncClient(options: SyncClientOptions): SyncClient {
  return new SyncClient(options);
}
