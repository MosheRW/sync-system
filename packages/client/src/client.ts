import {
  type ErrorMessage,
  type JoinCodesPayload,
  type JoinMethod,
  JOIN_REQUEST_ID_PATTERN,
  type JsonObject,
  type JsonValue,
  MAX_GROUP_ID_INPUT_LENGTH,
  classifyJoinCode,
  isDoorCode,
  isQrTicketShape,
  normalizeDisplayName,
  normalizeJoinCode,
  MAX_BLOCK_LIST_SIZE,
  MAX_TOKENS_PER_CHECK,
  PARTICIPANT_ID_PATTERN,
  type TokenStatus,
  MAX_JSON_DEPTH,
  type ServerMessage,
  type WelcomeMessage,
  checkJson,
  HANDOFF_MODES,
  type LeaderState,
  resolveDisplayName,
  CloseCode,
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
  CodesChangedReason,
  CreateGroupOptions,
  JoinByQrOptions,
  JoinCodes,
  JoinOptions,
  JoinRequest,
  QrTicket,
  JoinedGroup,
  ResumeOptions,
  ResumedGroup,
  StoredGroupStatus,
  SyncClientEvents,
  SyncClientSnapshot,
  RosterEntry,
  LeaderLifecycle,
} from './state.js';
import { LeaderData } from './leader-state.js';
import { LeaderPreview } from './preview.js';
import type { Recovery } from './token-store.js';
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
  'group.joinByCode': ['group.joined', 'join.pending'],
  'group.joinByQr': ['group.joined', 'join.pending'],
  'join.cancel': ['join.cancelled'],
  'join.approve': ['join.decided'],
  'join.deny': ['join.decided'],
  'qr.issue': ['qr.ticket'],
  'codes.rotate': ['codes.updated'],
  'position.update': ['position.ack'],
  'group.resume': ['group.resumed', 'group.joined', 'group.waiting'],
  'tokens.check': ['tokens.result'],
  'group.end': ['group.ended'],
  'group.leave': ['group.left'],
  'blocklist.set': ['blocklist.ack'],
  'vice.set': ['vice.updated'],
  'vice.clear': ['vice.updated'],
  'group.lock': ['lock.changed'],
  'group.unlock': ['lock.changed'],
  'member.remove': ['member.removed'],
  'leader.activity': ['activity.ack'],
  'keepalive.ack': ['activity.ack'],
  'leader.takeBack': ['leader.granted'],
};

/** A live leader (#13 D8). */
const ONLINE: LeaderLifecycle = Object.freeze({ status: 'online' });

/** The lifecycle from a pause on the wire, with a local grace end (#13 D8, D12). */
function lifecycleOf(
  pause: { cause: 'disconnected' | 'inactive'; graceMs?: number | undefined } | undefined,
): LeaderLifecycle {
  if (pause === undefined) return ONLINE;
  const status = pause.cause === 'disconnected' ? 'offline' : 'inactive';
  return Object.freeze(
    pause.graceMs === undefined ? { status } : { status, graceEndsAt: now() + pause.graceMs },
  );
}

/** Two lifecycles say the same (status and grace end). */
function sameLifecycle(a: LeaderLifecycle, b: LeaderLifecycle): boolean {
  if (a.status === 'online' || b.status === 'online') return a.status === b.status;
  return a.status === b.status && a.graceEndsAt === b.graceEndsAt;
}

/** The recovery fields of a leader state, for the token store (#13 D13). */
function recoveryState(
  state: LeaderState,
): Pick<Recovery, 'blockList' | 'locked' | 'viceId' | 'handoff'> {
  return {
    blockList: [...state.blockList],
    locked: state.locked,
    handoff: state.handoff,
    ...(state.viceId === undefined ? {} : { viceId: state.viceId }),
  };
}

/** The user's own chosen name from a reply, to send again on resume; none if generated. */
function ownName(reply: { displayName: string; generated: boolean }): string | undefined {
  return reply.generated ? undefined : reply.displayName;
}

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

/** Server answers that end a pending join request (#10 AC21, AC22, D9). */
const APPROVAL_OUTCOME_CODES: ReadonlySet<ClientErrorCode> = new Set<ClientErrorCode>([
  'JOIN_DENIED',
  'APPROVAL_TIMEOUT',
  'GROUP_FULL',
  'GROUP_ENDED',
]);

/** A join waiting for the leader's approval (#10 AC19, AC39). */
interface PendingApproval {
  readonly requestId: string;
  readonly resolve: (joined: JoinedGroup) => void;
  readonly reject: (error: SyncClientError) => void;
  readonly request: 'group.joinByCode' | 'group.joinByQr';
  timer: TimerHandle | undefined;
}

/** The leader-facing codes, without the signed blob (#10 AC40). */
function publicCodes(payload: JoinCodesPayload): JoinCodes {
  return Object.freeze({
    generation: payload.generation,
    ...(payload.groupCode === undefined ? {} : { groupCode: payload.groupCode }),
    ...(payload.doorCode === undefined ? {} : { doorCode: payload.doorCode }),
    ...(payload.alphaCode === undefined ? {} : { alphaCode: payload.alphaCode }),
  });
}

/** The leader's codes for its current group (#10 AC40). Never logged. */
interface LeaderCodes {
  readonly groupId: string;
  readonly joinMethods: readonly JoinMethod[];
  readonly codes: JoinCodes;
}

/** True for a usable group method set within the app's methods (#10 AC5, AC38). */
function validGroupMethods(raw: unknown, allowed: readonly JoinMethod[]): boolean {
  if (!Array.isArray(raw) || raw.length === 0) return false;
  const methods = raw as unknown[];
  if (new Set(methods).size !== methods.length) return false;
  if (!methods.every((m) => typeof m === 'string' && allowed.includes(m as JoinMethod))) {
    return false;
  }
  return !(methods.includes('A') && methods.includes('B'));
}

/** The validated display name, or a local INVALID_DISPLAY_NAME (#10 AC20). */
function checkDisplayName(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  const name = typeof raw === 'string' ? normalizeDisplayName(raw) : undefined;
  if (name === undefined) throw new SyncClientError('INVALID_DISPLAY_NAME');
  return name;
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
  /**
   * Set while the automatic group.resume after a reconnect has not settled
   * (storage read included). A drop meanwhile is not a stable connection
   * (#7 L4, L-1). Compared by identity, so a stale resume never clears a
   * newer one.
   */
  #autoResume: object | undefined;
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
  /** The join waiting for a leader's approval, if any (#10 AC39). */
  #approval: PendingApproval | undefined;
  /** Roster and recovery state of the group this client leads (#13 AC31, D13). */
  readonly #leaderData = new LeaderData();

  /**
   * The leader's private preview (#13 AC41): browse ahead without moving
   * the group; see `LeaderPreview`.
   */
  readonly preview: LeaderPreview = new LeaderPreview({
    isLeader: () => {
      const group = this.#snapshot.group;
      return group?.status === 'active' && group.role === 'leader';
    },
    groupPosition: () => {
      const group = this.#snapshot.group;
      return group?.status === 'active' && group.hasPosition ? group.position : undefined;
    },
    updatePosition: (position) => this.updatePosition(position),
    sendActivity: () => this.sendLeaderActivity(),
  });
  /** The leader's codes for its group (#10 AC40). */
  #leaderCodes: LeaderCodes | undefined;
  /** Pending join requests the leader was told about, by request ID (#10 AC40). */
  readonly #joinRequests = new Map<string, JoinRequest>();

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
  createGroup(
    metadata: JsonObject,
    initialPosition?: JsonValue,
    options?: CreateGroupOptions,
  ): Promise<CreatedGroup> {
    const invalid = localError(() => {
      this.#checkGroupRequest();
      if (!isJsonObject(metadata)) throw new SyncClientError('INVALID_PAYLOAD');
      this.#checkPayload('metadata', metadata);
      if (initialPosition !== undefined) this.#checkPayload('position', initialPosition);
      if (options?.joinMethods !== undefined) {
        // Within the app's methods from hello.ok, never A with B (#10 AC38).
        if (!validGroupMethods(options.joinMethods, this.#info?.joinMethods ?? [])) {
          throw new SyncClientError('JOIN_METHOD_UNAVAILABLE');
        }
      }
    });
    const nameInvalid = localError(() => {
      if (options?.handoff !== undefined && !HANDOFF_MODES.includes(options.handoff)) {
        throw new SyncClientError('INVALID_OPTIONS');
      }
      if (options?.displayName !== undefined && !resolveDisplayName(options.displayName).ok) {
        throw new SyncClientError('INVALID_DISPLAY_NAME');
      }
    });
    const refused = invalid ?? nameInvalid;
    if (refused) return Promise.reject(refused);
    const reqId = this.#requests.nextId();
    const message = {
      type: 'group.create' as const,
      reqId,
      metadata,
      ...(initialPosition === undefined ? {} : { position: initialPosition }),
      ...(options?.joinMethods === undefined ? {} : { joinMethods: [...options.joinMethods] }),
      ...(options?.handoff === undefined ? {} : { handoff: options.handoff }),
      ...(options?.displayName === undefined ? {} : { displayName: options.displayName }),
    };
    const result = deferred<CreatedGroup>();
    this.#trackGroupRequest('group.create', reqId, message, {
      resolve: (reply) => {
        if (reply.type !== 'group.created') return;
        void this.#tokens?.saveToken(
          reply.token,
          {
            metadata,
            hasPosition: initialPosition !== undefined,
            ...(initialPosition === undefined ? {} : { position: initialPosition }),
            ...recoveryState(reply.state),
            // From the server's reply: always stored (#10 AC32, N1).
            joinCodes: reply.codes.blob,
            joinCodesGeneration: reply.codes.generation,
          },
          ownName(reply),
        );
        this.#leaderData.reset(reply.groupId, reply.state);
        this.#startGroup({
          status: 'active',
          groupId: reply.groupId,
          role: 'leader',
          metadata,
          hasPosition: initialPosition !== undefined,
          position: initialPosition,
          leaderOnline: true,
          displayName: reply.displayName,
          generated: reply.generated,
          locked: reply.state.locked,
          leader: ONLINE,
          takeBackAvailable: false,
        });
        const codes = this.#setLeaderCodes(reply.groupId, reply.joinMethods, reply.codes);
        result.resolve(
          Object.freeze({
            groupId: reply.groupId,
            role: 'leader',
            participantId: reply.participantId,
            joinMethods: codes.joinMethods,
            codes: codes.codes,
          }),
        );
        this.#emitCodesChanged('created');
      },
      reject: (error) => result.reject(error),
    });
    return result.promise;
  }

  /**
   * Joins by code (#10 AC12, AC39): a 6-digit group code (method A with
   * `doorCode`, or B) or an 8-character code (C), typed in any case and with
   * spaces or hyphens. Resolves when the joiner is admitted, method B
   * included: meanwhile the group state is `awaiting_approval`. Rejects
   * locally with NOT_CONNECTED, ALREADY_IN_GROUP, REQUEST_IN_PROGRESS,
   * INVALID_JOIN_CODE (`details.field`), INVALID_DISPLAY_NAME or
   * JOIN_METHOD_UNAVAILABLE before anything is sent, and with the server's
   * code otherwise (DOOR_CODE_REQUIRED: ask for the door code and call again).
   */
  joinByCode(code: string, options?: JoinOptions): Promise<JoinedGroup> {
    let message: Record<string, unknown> | undefined;
    const invalid = localError(() => {
      this.#checkGroupRequest();
      const joinCode = typeof code === 'string' ? normalizeJoinCode(code) : '';
      const kind = classifyJoinCode(joinCode);
      if (kind === undefined) {
        throw new SyncClientError('INVALID_JOIN_CODE', { details: { field: 'code' } });
      }
      let doorCode: string | undefined;
      if (options?.doorCode !== undefined) {
        doorCode = typeof options.doorCode === 'string' ? normalizeJoinCode(options.doorCode) : '';
        if (!isDoorCode(doorCode)) {
          throw new SyncClientError('INVALID_JOIN_CODE', { details: { field: 'doorCode' } });
        }
      }
      const displayName = checkDisplayName(options?.displayName);
      const allowed = this.#info?.joinMethods ?? [];
      const usable: readonly JoinMethod[] = kind === 'group' ? ['A', 'B'] : ['C'];
      if (!usable.some((method) => allowed.includes(method))) {
        throw new SyncClientError('JOIN_METHOD_UNAVAILABLE');
      }
      message = {
        joinCode,
        ...(doorCode === undefined ? {} : { doorCode }),
        ...(displayName === undefined ? {} : { displayName }),
      };
    });
    if (invalid) return Promise.reject(invalid);
    this.#log('info', 'join_requested', { method: 'code' });
    return this.#joinRequest('group.joinByCode', message!);
  }

  /**
   * Joins with a QR ticket from a leader (#10 AC24, AC39). Same flow as
   * `joinByCode`; a group that needs approval puts the client in
   * `awaiting_approval`. Rejects locally with QR_INVALID (not a ticket),
   * JOIN_METHOD_UNAVAILABLE (the app has no D), INVALID_DISPLAY_NAME and the
   * usual group-request checks. The ticket is a bearer credential: it is
   * never logged.
   */
  joinByQr(ticket: string, options?: JoinByQrOptions): Promise<JoinedGroup> {
    let message: Record<string, unknown> | undefined;
    const invalid = localError(() => {
      this.#checkGroupRequest();
      if (!isQrTicketShape(ticket)) throw new SyncClientError('QR_INVALID');
      const displayName = checkDisplayName(options?.displayName);
      if (!(this.#info?.joinMethods ?? []).includes('D')) {
        throw new SyncClientError('JOIN_METHOD_UNAVAILABLE');
      }
      message = { ticket, ...(displayName === undefined ? {} : { displayName }) };
    });
    if (invalid) return Promise.reject(invalid);
    this.#log('info', 'join_requested', { method: 'qr' });
    return this.#joinRequest('group.joinByQr', message!);
  }

  /**
   * Withdraws the pending join request (#10 AC21, AC39): the join promise
   * rejects with JOIN_CANCELLED and the group state goes back to `null`.
   * Rejects with JOIN_REQUEST_NOT_FOUND when nothing is pending, which is
   * also the answer when the leader approved first (the join promise has
   * resolved then).
   */
  cancelJoin(): Promise<void> {
    if (this.#snapshot.connection.status !== 'connected') {
      return Promise.reject(new SyncClientError('NOT_CONNECTED'));
    }
    const approval = this.#approval;
    if (approval === undefined) {
      return Promise.reject(new SyncClientError('JOIN_REQUEST_NOT_FOUND'));
    }
    const reqId = this.#requests.nextId();
    const result = deferred<undefined>();
    this.#requests.add(reqId, {
      kind: 'join.cancel',
      timeoutKind: 'ack',
      timeoutMs: this.#opts.requestTimeoutMs,
      resolve: () => {
        if (this.#approval === approval) {
          this.#settleApproval();
          this.#log('info', 'join_settled', { outcome: 'cancelled' });
          approval.reject(new SyncClientError('JOIN_CANCELLED', { request: approval.request }));
        }
        result.resolve(undefined);
      },
      reject: (error) => result.reject(error),
    });
    this.#send({ type: 'join.cancel', reqId });
    return result.promise;
  }

  /**
   * The current codes of the group this client leads (#10 AC40), or `null`
   * when it does not lead an active group. Codes are not in the snapshot,
   * because apps often log or serialize it.
   */
  getJoinCodes(): JoinCodes | null {
    const group = this.#snapshot.group;
    const codes = this.#leaderCodes;
    if (group?.status !== 'active' || group.role !== 'leader') return null;
    return codes !== undefined && codes.groupId === group.groupId ? codes.codes : null;
  }

  /**
   * Pending join requests of the group this client leads, deduplicated by
   * request ID (#10 AC40). Requests the server re-sends after a reconnect
   * appear once.
   */
  getJoinRequests(): readonly JoinRequest[] {
    return Object.freeze([...this.#joinRequests.values()]);
  }

  /**
   * Replaces every code of the group this client leads (#10 AC30, AC40):
   * older QR tickets stop working, door-code failures reset and a pause is
   * lifted. Resolves with the new codes; `codesChanged` fires with reason
   * `rotated`. Rejects locally with NOT_CONNECTED, NOT_IN_GROUP or
   * NOT_LEADER, and with RATE_LIMITED (6 per minute) from the server.
   */
  rotateCodes(): Promise<JoinCodes> {
    const invalid = localError(() => this.#checkLeader('codes.rotate'));
    if (invalid) return Promise.reject(invalid);
    return this.#leaderRequest('codes.rotate', {}, (reply) => {
      if (reply.type !== 'codes.updated') throw invalidServerMessage(['type'], 'codes.rotate');
      this.#onCodesUpdated(reply);
      return this.#leaderCodes!.codes;
    });
  }

  /**
   * A QR ticket for the group this client leads (#10 AC23, AC40). The app
   * shows it (for example in a deep link's URL fragment) and asks for a new
   * one at about 80 % of its lifetime and after `codesChanged` with reason
   * `rotated` or `resumed`; the client never refreshes it on its own.
   * Rejects locally with NOT_CONNECTED, NOT_IN_GROUP, NOT_LEADER or
   * JOIN_METHOD_UNAVAILABLE (the group has no method D), and with
   * RATE_LIMITED (6 per minute) from the server.
   */
  issueQrTicket(): Promise<QrTicket> {
    const invalid = localError(() => {
      const group = this.#checkLeader('qr.issue');
      const codes = this.#leaderCodes;
      if (codes?.groupId === group.groupId && !codes.joinMethods.includes('D')) {
        throw new SyncClientError('JOIN_METHOD_UNAVAILABLE', { request: 'qr.issue' });
      }
    });
    if (invalid) return Promise.reject(invalid);
    return this.#leaderRequest('qr.issue', {}, (reply) => {
      if (reply.type !== 'qr.ticket') throw invalidServerMessage(['type'], 'qr.issue');
      this.#log('debug', 'qr_issued');
      return Object.freeze({ ticket: reply.ticket, expiresAt: now() + reply.expiresInMs });
    });
  }

  /**
   * Admits a pending joiner (#10 AC21, AC40). Resolves with `admitted`, or
   * `group_full` when the group filled up meanwhile. Rejects with
   * JOIN_REQUEST_NOT_FOUND for an unknown or already settled request.
   */
  approveJoin(requestId: string): Promise<'admitted' | 'group_full'> {
    return this.#decide('join.approve', requestId).then((outcome) =>
      outcome === 'group_full' ? 'group_full' : 'admitted',
    );
  }

  /** Refuses a pending joiner (#10 AC21, AC40). Same rejections as `approveJoin`. */
  denyJoin(requestId: string): Promise<void> {
    return this.#decide('join.deny', requestId).then(() => undefined);
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
        throw new SyncClientError('NOT_LEADER', { request: 'group.end' });
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
      throw new SyncClientError('NOT_LEADER', { request: 'position.update' });
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

  /** Local checks for leader calls: connected, in an active group, its leader. */
  #checkLeader(request: RequestKind): Extract<GroupState, { status: 'active' }> {
    if (this.#snapshot.connection.status !== 'connected') {
      throw new SyncClientError('NOT_CONNECTED');
    }
    const group = this.#snapshot.group;
    if (group === null || group.status === 'ended' || group.status === 'awaiting_approval') {
      throw new SyncClientError('NOT_IN_GROUP');
    }
    if (group.status !== 'active' || group.role !== 'leader') {
      throw new SyncClientError('NOT_LEADER', { request });
    }
    return group;
  }

  /** Sends a leader request and resolves with `map(reply)` (#10 AC40). */
  #leaderRequest<T>(
    kind:
      | 'codes.rotate'
      | 'qr.issue'
      | 'join.approve'
      | 'join.deny'
      | 'vice.set'
      | 'vice.clear'
      | 'group.lock'
      | 'group.unlock'
      | 'member.remove'
      | 'leader.activity'
      | 'keepalive.ack'
      | 'leader.takeBack',
    fields: Record<string, unknown>,
    map: (reply: ServerMessage) => T,
  ): Promise<T> {
    const reqId = this.#requests.nextId();
    const result = deferred<T>();
    this.#requests.add(reqId, {
      kind,
      timeoutKind: 'ack',
      timeoutMs: this.#opts.requestTimeoutMs,
      resolve: (reply) => {
        try {
          result.resolve(map(reply));
        } catch (error) {
          result.reject(error);
        }
      },
      reject: (error) => result.reject(error),
    });
    this.#send({ type: kind, reqId, ...fields });
    return result.promise;
  }

  #decide(
    kind: 'join.approve' | 'join.deny',
    requestId: string,
  ): Promise<'admitted' | 'group_full' | 'denied'> {
    const invalid = localError(() => {
      this.#checkLeader(kind);
      if (typeof requestId !== 'string' || !JOIN_REQUEST_ID_PATTERN.test(requestId)) {
        throw new SyncClientError('INVALID_PAYLOAD', { request: kind });
      }
    });
    if (invalid) return Promise.reject(invalid);
    return this.#leaderRequest(kind, { requestId }, (reply) => {
      if (reply.type !== 'join.decided') throw invalidServerMessage(['type'], kind);
      this.#joinRequests.delete(requestId);
      this.#log('info', 'join_decided', { outcome: reply.outcome });
      return reply.outcome;
    });
  }

  /** Keeps the leader's codes (#10 AC40) and returns them. */
  #setLeaderCodes(
    groupId: string,
    joinMethods: readonly JoinMethod[],
    payload: JoinCodesPayload,
  ): LeaderCodes {
    const codes: LeaderCodes = Object.freeze({
      groupId,
      joinMethods: Object.freeze([...joinMethods]),
      codes: publicCodes(payload),
    });
    this.#leaderCodes = codes;
    return codes;
  }

  #emitCodesChanged(reason: CodesChangedReason): void {
    const codes = this.#leaderCodes;
    if (codes === undefined) return;
    this.#log('info', 'codes_changed', { cause: reason });
    this.#events.emit(
      'codesChanged',
      Object.freeze({ groupId: codes.groupId, codes: codes.codes, reason }),
    );
  }

  /** `codes.updated` for the group this client leads (#10 AC29, AC30). */
  #onCodesUpdated(message: Extract<ServerMessage, { type: 'codes.updated' }>): void {
    const current = this.#leaderCodes;
    const group = this.#snapshot.group;
    const leads =
      (group?.status === 'active' || group?.status === 'rejoining') &&
      group.role === 'leader' &&
      group.groupId === message.groupId;
    if (!leads) return;
    this.#setLeaderCodes(message.groupId, current?.joinMethods ?? [], message.codes);
    void this.#tokens?.setJoinCodes(message.groupId, message.codes.blob, message.codes.generation, {
      fromServer: true,
    });
    this.#emitCodesChanged(message.reason);
  }

  /**
   * Leader: makes a connected member the vice-leader (#13 AC10), who takes
   * the lead first after a grace period. Resolves with the vice's ID.
   * Rejects locally with NOT_CONNECTED, NOT_IN_GROUP, NOT_LEADER or
   * INVALID_PAYLOAD, and from the server with PARTICIPANT_NOT_FOUND,
   * NOT_ALLOWED (the leader itself, an offline member) or RATE_LIMITED.
   */
  setViceLeader(participantId: string): Promise<string> {
    const invalid = localError(() => {
      this.#checkLeader('vice.set');
      if (typeof participantId !== 'string' || !PARTICIPANT_ID_PATTERN.test(participantId)) {
        throw new SyncClientError('INVALID_PAYLOAD', { request: 'vice.set' });
      }
    });
    if (invalid) return Promise.reject(invalid);
    return this.#leaderRequest('vice.set', { participantId }, (reply) => {
      if (reply.type !== 'vice.updated') throw invalidServerMessage(['type'], 'vice.set');
      this.#onLeaderState(reply.groupId, { viceId: reply.viceId ?? undefined });
      return participantId;
    });
  }

  /** Leader: clears the vice-leader (#13 AC10). Same rejections as `setViceLeader`. */
  clearViceLeader(): Promise<void> {
    const invalid = localError(() => this.#checkLeader('vice.clear'));
    if (invalid) return Promise.reject(invalid);
    return this.#leaderRequest('vice.clear', {}, (reply) => {
      if (reply.type !== 'vice.updated') throw invalidServerMessage(['type'], 'vice.clear');
      this.#onLeaderState(reply.groupId, { viceId: undefined });
    });
  }

  /**
   * Leader: stops all new joining by every method (#13 AC29); members get
   * `lockChanged`. Members already admitted still rejoin by token.
   */
  lockGroup(): Promise<void> {
    return this.#setLock('group.lock');
  }

  /** Leader: allows joining again (#13 AC29). */
  unlockGroup(): Promise<void> {
    return this.#setLock('group.unlock');
  }

  #setLock(kind: 'group.lock' | 'group.unlock'): Promise<void> {
    const invalid = localError(() => this.#checkLeader(kind));
    if (invalid) return Promise.reject(invalid);
    return this.#leaderRequest(kind, {}, (reply) => {
      if (reply.type !== 'lock.changed') throw invalidServerMessage(['type'], kind);
      this.#onLeaderState(reply.groupId, { locked: reply.locked });
      this.#applyLock(reply.groupId, reply.locked);
    });
  }

  /**
   * Leader: removes a participant for the rest of the session (#13 AC32):
   * it is blocked, its connection is closed and every code rotates
   * (`codesChanged` with reason `member_removed`). Resolves with the full
   * block list, which is also stored for recovery. Works on offline roster
   * members too. Rejects locally like `setViceLeader`, and from the server
   * with PARTICIPANT_NOT_FOUND, NOT_ALLOWED (the leader), BLOCK_LIST_FULL,
   * CODES_EXHAUSTED or RATE_LIMITED.
   */
  removeMember(participantId: string): Promise<readonly string[]> {
    const invalid = localError(() => {
      this.#checkLeader('member.remove');
      if (typeof participantId !== 'string' || !PARTICIPANT_ID_PATTERN.test(participantId)) {
        throw new SyncClientError('INVALID_PAYLOAD', { request: 'member.remove' });
      }
    });
    if (invalid) return Promise.reject(invalid);
    return this.#leaderRequest('member.remove', { participantId }, (reply) => {
      if (reply.type !== 'member.removed') throw invalidServerMessage(['type'], 'member.remove');
      this.#onLeaderState(reply.groupId, { blockList: reply.blockList });
      this.#log('info', 'member_removed');
      return Object.freeze([...reply.blockList]);
    });
  }

  /** A change of the leader recovery state: kept in memory and in storage (#13 D13). */
  #onLeaderState(groupId: string, patch: Partial<LeaderState>): void {
    if (this.#leaderData.groupId !== groupId) return;
    this.#leaderData.patchState(patch);
    const state = this.#leaderData.state();
    if (state !== null) void this.#tokens?.updateRecovery(groupId, recoveryState(state));
  }

  /**
   * Leader: answers the keep-alive prompt (#13 AC16). Any counted activity
   * (a position update, for example) answers it too. Rejects locally with
   * NOT_CONNECTED, NOT_IN_GROUP or NOT_LEADER.
   */
  answerKeepAlive(): Promise<void> {
    const invalid = localError(() => this.#checkLeader('keepalive.ack'));
    if (invalid) return Promise.reject(invalid);
    return this.#leaderRequest('keepalive.ack', {}, () => undefined);
  }

  /**
   * Leader: "still here" without moving the group (#13 AC30), for example
   * while previewing. No position is sent. Limited by the server to 12 per
   * minute; the preview helper throttles it.
   */
  sendLeaderActivity(): Promise<void> {
    const invalid = localError(() => this.#checkLeader('leader.activity'));
    if (invalid) return Promise.reject(invalid);
    return this.#leaderRequest('leader.activity', {}, () => undefined);
  }

  /**
   * The displaced leader takes the lead back (#13 AC24), while
   * `takeBackAvailable`. Resolves when this client leads again (a new
   * leader token is stored and `nowLeading` fires). Rejects locally with
   * NOT_CONNECTED or NOT_IN_GROUP, and from the server with NOT_ALLOWED or
   * RATE_LIMITED.
   */
  takeBackLeadership(): Promise<void> {
    const invalid = localError(() => {
      if (this.#snapshot.connection.status !== 'connected') {
        throw new SyncClientError('NOT_CONNECTED');
      }
      const group = this.#snapshot.group;
      if (group?.status !== 'active') throw new SyncClientError('NOT_IN_GROUP');
    });
    if (invalid) return Promise.reject(invalid);
    return this.#leaderRequest('leader.takeBack', {}, (reply) => {
      if (reply.type !== 'leader.granted') {
        throw invalidServerMessage(['type'], 'leader.takeBack');
      }
      this.#onGranted(reply);
    });
  }

  /**
   * "You're now leading" (#13 AC23): the new leader token is stored with
   * recovery data built from the active group, the server's recovery state
   * and the codes; the client leads from now on.
   */
  #onGranted(message: Extract<ServerMessage, { type: 'leader.granted' }>): void {
    const group = this.#snapshot.group;
    if (group?.status !== 'active' || group.groupId !== message.groupId) return;
    void this.#tokens?.saveToken(message.token, {
      metadata: group.metadata,
      hasPosition: group.hasPosition,
      ...(group.hasPosition ? { position: group.position } : {}),
      ...recoveryState(message.state),
      joinCodes: message.codes.blob,
      joinCodesGeneration: message.codes.generation,
    });
    this.#leaderData.reset(message.groupId, message.state);
    this.#startGroup({
      ...group,
      role: 'leader',
      leaderOnline: true,
      leader: ONLINE,
      locked: message.state.locked,
      takeBackAvailable: false,
    });
    this.#setLeaderCodes(message.groupId, message.joinMethods, message.codes);
    this.#log('info', 'now_leading', { cause: message.reason });
    this.#events.emit(
      'nowLeading',
      Object.freeze({ groupId: message.groupId, reason: message.reason }),
    );
    this.#emitCodesChanged('resumed');
  }

  /**
   * This client leads no more (#13 AC23, RC12): the member token replaces
   * the leader token (its recovery data goes), and the roster, recovery
   * state, codes and pending requests are dropped.
   */
  #onLost(message: Extract<ServerMessage, { type: 'leader.lost' }>): void {
    const group = this.#snapshot.group;
    if (group?.status !== 'active' || group.groupId !== message.groupId) return;
    void this.#tokens?.saveToken(message.token);
    this.#leaderData.clear();
    this.#leaderCodes = undefined;
    this.#joinRequests.clear();
    this.#startGroup({
      ...group,
      role: 'member',
      takeBackAvailable: message.takeBackAvailable,
    });
    this.#log('info', 'leadership_lost', { cause: message.reason });
    this.#events.emit(
      'leadershipLost',
      Object.freeze({
        groupId: message.groupId,
        reason: message.reason,
        takeBackAvailable: message.takeBackAvailable,
      }),
    );
  }

  /** The lock flag of the active group, and `lockChanged` (#13 AC29). */
  #applyLock(groupId: string, locked: boolean): void {
    const group = this.#snapshot.group;
    if (group?.status !== 'active' || group.groupId !== groupId || group.locked === locked) return;
    this.#update({ group: { ...group, locked } });
    this.#events.emit('lockChanged', Object.freeze({ groupId, locked }));
  }

  /**
   * The roster of the group this client leads, in admission order (#13
   * AC31), or `[]`. Names are untrusted plain text.
   */
  getRoster(): readonly RosterEntry[] {
    return this.#leaderData.roster();
  }

  /** The recovery state of the group this client leads (#13 D13), or null. */
  getLeaderState(): LeaderState | null {
    return this.#leaderData.state();
  }

  /** Roster frames for the group this client leads (#13 AC31). */
  #onRoster(
    message: Extract<
      ServerMessage,
      { type: 'roster.snapshot' | 'roster.updated' | 'roster.removed' }
    >,
  ): void {
    const data = this.#leaderData;
    const changed =
      message.type === 'roster.snapshot'
        ? data.snapshot(message.groupId, message.participants)
        : message.type === 'roster.updated'
          ? data.update(message.groupId, message.participant)
          : data.remove(message.groupId, message.participantId);
    if (!changed) return;
    this.#events.emit(
      'rosterChanged',
      Object.freeze({ groupId: message.groupId, roster: data.roster() }),
    );
  }

  /** True when `groupId` is the active group this client leads. */
  #leads(groupId: string): boolean {
    const group = this.#snapshot.group;
    return group?.status === 'active' && group.role === 'leader' && group.groupId === groupId;
  }

  /** Leader-side join events (#10 AC19, AC21, AC29, AC40). */
  #onLeaderEvent(
    message: Extract<
      ServerMessage,
      { type: 'join.requested' | 'join.withdrawn' | 'join.paused' | 'join.resumed' }
    >,
  ): void {
    if (!this.#leads(message.groupId)) return;
    switch (message.type) {
      case 'join.requested': {
        // The leader app renders the name, so it passes the same rule the
        // server applied; a name that fails it (other Unicode data, a
        // misbehaving server) is dropped, the request itself is kept.
        const displayName =
          message.displayName !== undefined &&
          normalizeDisplayName(message.displayName) === message.displayName
            ? message.displayName
            : undefined;
        const request: JoinRequest = Object.freeze({
          requestId: message.requestId,
          ...(displayName === undefined ? {} : { displayName }),
          expiresAt: now() + message.expiresInMs,
        });
        const known = this.#joinRequests.has(message.requestId);
        this.#joinRequests.set(message.requestId, request);
        this.#log('info', 'join_request_received', { count: this.#joinRequests.size });
        if (!known) {
          this.#events.emit(
            'joinRequested',
            Object.freeze({ groupId: message.groupId, ...request }),
          );
        }
        return;
      }
      case 'join.withdrawn':
        if (!this.#joinRequests.delete(message.requestId)) return;
        this.#events.emit(
          'joinWithdrawn',
          Object.freeze({
            groupId: message.groupId,
            requestId: message.requestId,
            reason: message.reason,
          }),
        );
        return;
      case 'join.paused':
        this.#log('info', 'join_paused');
        this.#events.emit(
          'joinPaused',
          Object.freeze({ groupId: message.groupId, retryAfterMs: message.retryAfterMs }),
        );
        return;
      case 'join.resumed':
        this.#log('info', 'join_resumed');
        this.#events.emit('joinResumed', Object.freeze({ groupId: message.groupId }));
        return;
    }
  }

  /**
   * Sends a code or QR join and tracks it (#10 AC39, 7.2): `group.joined`
   * admits at once; `join.pending` moves to `awaiting_approval` until an
   * unsolicited `group.joined` or error settles it.
   */
  #joinRequest(
    kind: 'group.joinByCode' | 'group.joinByQr',
    fields: Record<string, unknown>,
  ): Promise<JoinedGroup> {
    const reqId = this.#requests.nextId();
    const result = deferred<JoinedGroup>();
    this.#trackGroupRequest(
      kind,
      reqId,
      { type: kind, reqId, ...fields },
      {
        resolve: (reply) => {
          if (reply.type === 'group.joined') {
            this.#log('info', 'join_settled', { outcome: 'admitted' });
            result.resolve(this.#joinedAsMember(reply));
            return;
          }
          if (reply.type !== 'join.pending') return;
          this.#awaitApproval(kind, reply.requestId, reply.timeoutMs, result);
        },
        reject: (error) => {
          this.#log('info', 'join_settled', { outcome: 'rejected', code: error.code });
          result.reject(error);
        },
      },
    );
    return result.promise;
  }

  /**
   * `join.pending` (#10 AC19, 7.2): the group state is `awaiting_approval`
   * with a local deadline. A local guard drops the connection if neither an
   * answer nor the server's own timeout arrives by deadline plus
   * `requestTimeoutMs`.
   */
  #awaitApproval(
    request: 'group.joinByCode' | 'group.joinByQr',
    requestId: string,
    timeoutMs: number,
    result: Deferred<JoinedGroup>,
  ): void {
    const expiresAt = now() + timeoutMs;
    const approval: PendingApproval = {
      requestId,
      request,
      resolve: (joined) => result.resolve(joined),
      reject: (error) => result.reject(error),
      timer: undefined,
    };
    approval.timer = setClampedTimeout(() => {
      approval.timer = undefined;
      if (this.#approval !== approval) return;
      this.#approval = undefined;
      this.#log('debug', 'request_timeout', { request });
      const error = new SyncClientError('REQUEST_TIMEOUT', { request });
      approval.reject(error);
      // The drop clears the awaiting_approval state; the server withdraws the request.
      this.#connectionLost(error);
    }, timeoutMs + this.#opts.requestTimeoutMs);
    this.#approval = approval;
    this.#log('info', 'join_pending');
    this.#update({ group: { status: 'awaiting_approval', requestId, expiresAt } });
  }

  /** Clears the pending approval and its timer, and the group state when it shows it. */
  #settleApproval(): void {
    const approval = this.#approval;
    if (approval === undefined) return;
    clearTimer(approval.timer);
    this.#approval = undefined;
    if (this.#snapshot.group?.status === 'awaiting_approval') this.#update({ group: null });
  }

  /** A member admitted by code, ticket or approval: token stored, group active. */
  #joinedAsMember(reply: Extract<ServerMessage, { type: 'group.joined' }>): JoinedGroup {
    void this.#tokens?.saveToken(reply.token, undefined, ownName(reply));
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
      displayName: reply.displayName,
      generated: reply.generated,
      locked: reply.locked,
      leader: lifecycleOf(reply.leaderPause),
      takeBackAvailable: false,
    });
    return joined;
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
        if (
          current !== null &&
          current.status !== 'ended' &&
          current.status !== 'awaiting_approval' &&
          current.groupId === groupId
        ) {
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
    kind: 'group.create' | 'group.joinByCode' | 'group.joinByQr' | 'group.resume',
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
    // The leader's codes, request list, roster and recovery state belong to
    // the group (#10 AC40, #13 RC12).
    this.#leaderCodes = undefined;
    this.#joinRequests.clear();
    this.#leaderData.clear();
    if (group === null || group.status === 'ended') return;
    // Never in a group: a pending join request just goes away (#10 7.2).
    if (group.status === 'awaiting_approval') {
      this.#update({ group: null });
      return;
    }
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
    const {
      maxGroupSize,
      maxLeaderUpdatesPerSecond,
      maxMessageBytes,
      maxSessionMinutes,
      qrTicketSeconds,
      approvalTimeoutSeconds,
      inactivityLimitMinutes,
      disconnectGraceSeconds,
      keepAliveCountdownSeconds,
    } = message.limits;
    const limits = Object.freeze({
      maxGroupSize,
      maxLeaderUpdatesPerSecond,
      maxMessageBytes,
      maxSessionMinutes,
      qrTicketSeconds,
      approvalTimeoutSeconds,
      inactivityLimitMinutes,
      disconnectGraceSeconds,
      keepAliveCountdownSeconds,
    });
    const info: ConnectedInfo = Object.freeze({
      participantId: message.participantId,
      namespace: message.namespace,
      joinMethods: Object.freeze([...new Set(message.joinMethods)]),
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
        resume: (groupId, callbacks) => {
          const marker = {};
          this.#autoResume = marker;
          const settled = () => {
            if (this.#autoResume === marker) this.#autoResume = undefined;
          };
          this.#resume(groupId, undefined, {
            resolve: (resumed) => {
              settled();
              callbacks.resolve(resumed);
            },
            reject: (error) => {
              settled();
              callbacks.reject(error);
            },
          });
        },
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
        // The newest codes blob this client has, to keep the codes (#10 AC32, AC33).
        ...(leader && recovery?.joinCodes !== undefined ? { joinCodes: recovery.joinCodes } : {}),
        // #13 D13: the rest of the leader recovery state, for a recreation.
        ...(leader && recovery?.locked !== undefined ? { locked: recovery.locked } : {}),
        ...(leader && recovery?.viceId !== undefined ? { viceId: recovery.viceId } : {}),
        ...(leader && recovery?.handoff !== undefined ? { handoff: recovery.handoff } : {}),
        // The user's own name, sent again on every resume (#13 Q5.4).
        ...(entry.displayName === undefined ? {} : { displayName: entry.displayName }),
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
      void this.#tokens?.saveToken(
        reply.token,
        {
          metadata: reply.metadata,
          hasPosition: reply.hasPosition,
          ...(reply.hasPosition ? { position: reply.position } : {}),
          // The server's recovery state wins (#13 D13; the block list only grows).
          ...recoveryState(reply.state),
          // The server's current codes: always stored, even with a lower generation (#10 N1).
          joinCodes: reply.codes.blob,
          joinCodesGeneration: reply.codes.generation,
        },
        ownName(reply),
      );
      this.#leaderData.reset(groupId, reply.state);
      this.#startGroup({
        status: 'active',
        groupId,
        role: 'leader',
        metadata: reply.metadata,
        hasPosition: reply.hasPosition,
        position: reply.hasPosition ? reply.position : undefined,
        leaderOnline: true,
        displayName: reply.displayName,
        generated: reply.generated,
        locked: reply.state.locked,
        leader: ONLINE,
        takeBackAvailable: false,
      });
      // The current codes come back with every leader resume (#10 AC33, AC34).
      this.#setLeaderCodes(groupId, reply.joinMethods, reply.codes);
      if (reply.codesChanged) this.#emitCodesChanged('resumed');
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
    void this.#tokens?.saveToken(reply.token, undefined, ownName(reply));
    // A member token: no leader-only data stays (#13 RC12).
    this.#leaderData.clear();
    this.#startGroup({
      status: 'active',
      groupId: reply.groupId,
      role: 'member',
      metadata: reply.metadata,
      hasPosition: reply.hasPosition,
      position: reply.hasPosition ? reply.position : undefined,
      leaderOnline: reply.leaderOnline,
      displayName: reply.displayName,
      generated: reply.generated,
      locked: reply.locked,
      leader: lifecycleOf(reply.leaderPause),
      takeBackAvailable: false,
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
          if (this.#approval !== undefined) {
            this.#onApproved(message);
            return;
          }
          this.#onParkedAdmission(message);
          return;
        }
        this.#onReply(message);
        return;
      case 'join.pending':
      case 'join.cancelled':
      case 'join.decided':
      case 'qr.ticket':
        this.#onReply(message);
        return;
      case 'codes.updated':
        // A reply to codes.rotate, or unsolicited after door-code failures.
        if (message.reqId !== undefined && this.#requests.get(message.reqId) !== undefined) {
          this.#onReply(message);
          return;
        }
        this.#onCodesUpdated(message);
        return;
      case 'join.requested':
      case 'join.withdrawn':
      case 'join.paused':
      case 'join.resumed':
        this.#onLeaderEvent(message);
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
        const leader: LeaderLifecycle =
          message.type === 'leader.online'
            ? ONLINE
            : lifecycleOf({ cause: message.cause ?? 'disconnected', graceMs: message.graceMs });
        // A repeat of the same status is not news.
        if (group.leaderOnline === online && sameLifecycle(group.leader, leader)) return;
        this.#update({ group: { ...group, leaderOnline: online, leader } });
        this.#log('info', 'leader_status', { online });
        this.#events.emit(
          'leaderStatus',
          Object.freeze({
            groupId: group.groupId,
            online,
            ...(message.type === 'leader.offline' && message.cause !== undefined
              ? { cause: message.cause }
              : {}),
            ...(leader.status !== 'online' && leader.graceEndsAt !== undefined
              ? { graceEndsAt: leader.graceEndsAt }
              : {}),
          }),
        );
        return;
      }
      case 'keepalive.prompt':
        if (!this.#leads(message.groupId)) return;
        this.#log('info', 'keepalive_prompt');
        this.#events.emit(
          'keepAlive',
          Object.freeze({
            groupId: message.groupId,
            countdownMs: message.countdownMs,
            deadlineAt: now() + message.countdownMs,
          }),
        );
        return;
      case 'keepalive.cleared':
        if (!this.#leads(message.groupId)) return;
        this.#events.emit('keepAliveCleared', Object.freeze({ groupId: message.groupId }));
        return;
      case 'activity.ack':
        this.#onReply(message);
        return;
      case 'leader.granted':
        if (message.reqId !== undefined && this.#requests.get(message.reqId) !== undefined) {
          this.#onReply(message);
          return;
        }
        this.#onGranted(message);
        return;
      case 'leader.lost':
        this.#onLost(message);
        return;
      case 'leader.changed': {
        const group = this.#snapshot.group;
        if (group?.status !== 'active' || group.groupId !== message.groupId) return;
        this.#log('info', 'leader_changed', { cause: message.reason });
        this.#events.emit(
          'leaderChanged',
          Object.freeze({ groupId: message.groupId, reason: message.reason }),
        );
        return;
      }
      case 'takeback.offered': {
        const group = this.#snapshot.group;
        if (group?.status !== 'active' || group.groupId !== message.groupId) return;
        this.#update({ group: { ...group, takeBackAvailable: true } });
        this.#events.emit('takeBackOffered', Object.freeze({ groupId: message.groupId }));
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
      case 'roster.snapshot':
      case 'roster.updated':
      case 'roster.removed':
        this.#onRoster(message);
        return;
      case 'vice.updated':
      case 'member.removed':
        this.#onReply(message);
        return;
      case 'lock.changed':
        // A reply to lock/unlock, or a member hearing about it.
        if (message.reqId !== undefined && this.#requests.get(message.reqId) !== undefined) {
          this.#onReply(message);
          return;
        }
        this.#applyLock(message.groupId, message.locked);
        return;
      case 'vice.changed': {
        const group = this.#snapshot.group;
        if (group?.status !== 'active' || group.groupId !== message.groupId) return;
        this.#log('info', 'vice_changed', { isVice: message.isVice });
        this.#events.emit(
          'viceChanged',
          Object.freeze({ groupId: message.groupId, isVice: message.isVice }),
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
        if (
          group === null ||
          group.status === 'ended' ||
          group.status === 'awaiting_approval' ||
          group.groupId !== message.groupId
        ) {
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
    // While awaiting approval, an error without reqId settles the request (#10 AC21, D9).
    const approval = this.#approval;
    if (
      message.reqId === undefined &&
      approval !== undefined &&
      APPROVAL_OUTCOME_CODES.has(message.code)
    ) {
      this.#settleApproval();
      this.#log('info', 'join_settled', { outcome: 'rejected', code: message.code });
      approval.reject(fromServerError(message, { request: approval.request }));
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

  /** The leader approved the pending join request (#10 AC21). */
  #onApproved(message: Extract<ServerMessage, { type: 'group.joined' }>): void {
    const approval = this.#approval!;
    clearTimer(approval.timer);
    this.#approval = undefined;
    this.#log('info', 'join_settled', { outcome: 'admitted' });
    approval.resolve(this.#joinedAsMember(message));
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
    if (code === CloseCode.REMOVED) {
      this.#onRemoved();
      return;
    }
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
    this.#autoResume = undefined;
    const transport = this.#transport;
    this.#transport = undefined;
    transport?.retire(1000, closeReason);
    this.#phase = 'welcome';
    this.#info = undefined;
    this.#throttle?.cancel();
    this.#requests.rejectAll(requestError);
    // A pending join request is lost with the connection; it is never
    // re-sent (#10 Q6.3). The group state is cleared by the caller's flow.
    const approval = this.#approval;
    if (approval !== undefined) {
      clearTimer(approval.timer);
      this.#approval = undefined;
      this.#log('info', 'join_settled', { outcome: 'lost' });
      approval.reject(new SyncClientError(requestError.code, { request: approval.request }));
    }
  }

  /**
   * The leader removed this participant (#13 AC32, Gate 2 Q-A): close 4004
   * right after `group.ended removed`. Terminal: no reconnect, the group's
   * token and recovery data are deleted, the client is `closed` (reason
   * `removed`) until the app calls `connect()`, and `removed` fires.
   */
  #onRemoved(): void {
    const generation = this.#generation;
    const group = this.#snapshot.group;
    const groupId =
      group !== null && group.status !== 'awaiting_approval' ? group.groupId : undefined;
    const error = new SyncClientError('REMOVED', { fatal: true, source: 'server' });
    this.#log('info', 'removed');
    this.#teardown(error, error.code);
    if (groupId !== undefined) void this.#tokens?.remove([groupId]);
    if (group?.status !== 'ended') this.#endGroup('removed');
    if (generation !== this.#generation) return;
    const run = this.#takeRun();
    this.#update({ connection: { status: 'closed', reason: 'removed', error } });
    run?.reject(error);
    if (generation !== this.#generation || groupId === undefined) return;
    this.#events.emit('removed', Object.freeze({ groupId }));
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
   * and the attempt count first (H1, R2-L5), unless its group.resume timed
   * out or was still pending (#7 L4, L-1): a resume that never completed is
   * not a stable connection, so a server that ignores it cannot keep the
   * client reconnecting forever.
   */
  #connectionLost(error: SyncClientError, busy?: BusySignal): void {
    const generation = this.#generation;
    this.#log('info', 'connection_lost', { code: error.code });
    const wasConnected = this.#phase === 'ready';
    // Read before teardown, which settles the pending resume.
    const resumeUnsettled = this.#autoResume !== undefined || isResumeTimeout(error);
    const group = this.#snapshot.group;
    this.#teardown(new SyncClientError('CONNECTION_LOST'));
    if (generation !== this.#generation) return;
    if (wasConnected && !resumeUnsettled) {
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
    // The server re-sends pending requests when the leader is back (#10 AC34).
    this.#joinRequests.clear();
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

/** The client-side timeout of a group.resume request (#7 L4). */
function isResumeTimeout(error: SyncClientError): boolean {
  return (
    error.code === 'REQUEST_TIMEOUT' &&
    error.request === 'group.resume' &&
    error.source === 'client'
  );
}

/** Factory alias for apps that prefer functions. */
export function createSyncClient(options: SyncClientOptions): SyncClient {
  return new SyncClient(options);
}
