import type {
  GroupEndedInfo,
  JoinCodes,
  JoinedGroup,
  JoinRequest,
  KeepAliveEvent,
  LeaderState,
  PreviewState,
  RosterEntry,
  StoredGroupStatus,
  SyncClientError,
  SyncClientEvents,
  SyncClientSnapshot,
} from '@sync-system/client';
import { now } from './host.js';
import { QrTicketController } from './qr-controller.js';
import {
  EMPTY_LIST,
  IDLE_JOIN_FLOW,
  IDLE_PREVIEW,
  IDLE_QR,
  IDLE_SNAPSHOT,
  SERVER_STATE,
} from './server-state.js';
import { toSyncError } from './to-sync-error.js';
import type {
  JoinFlowState,
  JoinPausedState,
  LeadershipChange,
  StoredGroup,
  SyncClientLike,
  SyncState,
} from './types.js';

/** Which join call started the current join flow. */
export type JoinKind = 'code' | 'qr';

/** The events the store listens to while attached (section 6). */
const EVENTS = [
  'codesChanged',
  'joinRequested',
  'joinWithdrawn',
  'joinPaused',
  'joinResumed',
  'rosterChanged',
  'viceChanged',
  'lockChanged',
  'keepAlive',
  'keepAliveCleared',
  'nowLeading',
  'leadershipLost',
  'leaderChanged',
  'takeBackOffered',
  'removed',
  'error',
  'groupEnded',
  'rejoined',
  'state',
] as const satisfies readonly (keyof SyncClientEvents)[];

/** The group ID of an active group this client leads, else null. */
export function leadingGroupId(snapshot: SyncClientSnapshot): string | null {
  const group = snapshot.group;
  return group?.status === 'active' && group.role === 'leader' ? group.groupId : null;
}

/** The ID of the group this client is in (active, rejoining or waiting), else null. */
export function currentGroupId(snapshot: SyncClientSnapshot): string | null {
  const group = snapshot.group;
  if (group === null || group.status === 'ended' || group.status === 'awaiting_approval') {
    return null;
  }
  return group.groupId;
}

/** Availability of a stored group (AC16). */
export function availabilityOf(status: StoredGroupStatus['status']): StoredGroup['availability'] {
  switch (status) {
    case 'live':
      return 'live';
    case 'recoverable':
    case 'waiting':
      return 'resumable';
    default:
      return 'gone';
  }
}

interface JoinFlowRecord {
  readonly id: number;
  /** The snapshot showed `awaiting_approval` during this flow. */
  sawWaiting: boolean;
  state: JoinFlowState;
}

interface ViceRecord {
  readonly groupId: string;
  readonly isVice: boolean;
}

/**
 * The package's state store (D2), framework-free. Composes the core
 * snapshot with the leader-only and event-derived data the core does not
 * keep in it, as one identity-stable value for `useSyncExternalStore`.
 *
 * Leader-only parts (codes, requests, roster, leader state, block list,
 * keep-alive prompt, join pause) are read from the core getters only while
 * this client leads the current active group, and identity is kept only
 * against a previous value of the same group (R3). A store over no client
 * is inert: it never changes, starts nothing and records nothing (R6).
 */
export class SyncStore {
  readonly client: SyncClientLike | null;
  readonly #base: SyncState;
  readonly #listeners = new Set<() => void>();
  #attachCount = 0;
  #unsubscribers: (() => void)[] = [];
  #state: SyncState;
  /** The lead group the cached leader-only parts belong to. */
  #stateLeadGroup: string | null = null;
  #dirty = true;
  /** The snapshot the event-derived resets were last applied to. */
  #seen: SyncClientSnapshot = IDLE_SNAPSHOT;

  // Event-derived state (D11): starts when the store attaches.
  #lastError: SyncClientError | null = null;
  #keepAlive: KeepAliveEvent | null = null;
  #joinPaused: JoinPausedState | null = null;
  #vice: ViceRecord | null = null;
  #leadership: LeadershipChange | null = null;
  #flow: JoinFlowRecord = { id: 0, sawWaiting: false, state: IDLE_JOIN_FLOW };
  #flowIds = 0;
  #waiting: Extract<JoinFlowState, { status: 'waiting' }> | null = null;
  #storedGroups: readonly StoredGroup[] | null = null;
  #check: Promise<readonly StoredGroup[]> | undefined;
  #sessionChecked = false;
  /** Block list results of actions, by group (R3). */
  #blockList: { readonly groupId: string; readonly list: readonly string[] } | null = null;
  /** The core block list the action result above was recorded against. */
  #blockListBase: readonly string[] | null = null;
  /** The shared QR ticket re-issue timer (D5); inert over no client. */
  readonly qr: QrTicketController;

  /**
   * No side effects: nothing is read from the client and nothing subscribes
   * until `attach()`. `initError`: the owned client could not be created
   * (`INVALID_OPTIONS`); the store then reports a closed, fatal connection.
   */
  constructor(client: SyncClientLike | null, initError?: SyncClientError) {
    this.client = client;
    this.#base =
      client === null && initError !== undefined
        ? Object.freeze({
            ...SERVER_STATE,
            snapshot: Object.freeze({
              connection: Object.freeze({
                status: 'closed' as const,
                reason: 'fatal' as const,
                error: initError,
              }),
              group: null,
            }),
            lastError: initError,
          })
        : SERVER_STATE;
    this.#state = this.#base;
    this.qr = new QrTicketController({
      client,
      connectedLeadGroupId: () =>
        client !== null && client.getSnapshot().connection.status === 'connected'
          ? leadingGroupId(client.getSnapshot())
          : null,
      changed: () => this.changed(),
    });
  }

  /**
   * Subscribes to the client's snapshot and events. Idempotent and
   * ref-counted; returns the detach function. Re-reads every getter (D11).
   */
  attach(): () => void {
    const client = this.client;
    if (client === null) return () => undefined;
    this.#attachCount += 1;
    if (this.#attachCount === 1) {
      this.#unsubscribers = [
        client.subscribe(this.#onSnapshot),
        ...EVENTS.map((event) =>
          client.on(event, (payload) => this.#onEvent(event, payload as never)),
        ),
      ];
      this.#seen = client.getSnapshot();
      this.#dirty = true;
      this.qr.evaluate();
      this.#notify();
    }
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      this.#attachCount -= 1;
      if (this.#attachCount > 0) return;
      // The QR controller is stopped by its consumers' release, not here:
      // StrictMode detaches and re-attaches synchronously.
      for (const off of this.#unsubscribers.splice(0)) off();
    };
  }

  subscribe(listener: () => void): () => void {
    if (this.client === null) return () => undefined;
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The current state; the same object until something changed. */
  getState(): SyncState {
    const client = this.client;
    if (client === null) return this.#base;
    const snapshot = client.getSnapshot();
    if (!this.#dirty && snapshot === this.#state.snapshot) return this.#state;
    this.#dirty = false;
    this.#prune(snapshot);
    const prev = this.#state;
    const lead = leadingGroupId(snapshot);
    const same = lead !== null && lead === this.#stateLeadGroup;

    const codes = lead === null ? null : keepCodes(same ? prev.codes : null, client.getJoinCodes());
    const joinRequests =
      lead === null
        ? EMPTY_LIST
        : keepList(same ? prev.joinRequests : EMPTY_LIST, client.getJoinRequests(), sameRequest);
    const roster =
      lead === null
        ? EMPTY_LIST
        : keepList(same ? prev.roster : EMPTY_LIST, client.getRoster(), sameRosterEntry);
    const leaderState =
      lead === null
        ? null
        : keepLeaderState(same ? prev.leaderState : null, client.getLeaderState());
    const blockList =
      lead === null
        ? EMPTY_LIST
        : this.#blockListFor(lead, leaderState, same ? prev.blockList : EMPTY_LIST);

    const next: SyncState = {
      snapshot,
      codes,
      joinRequests,
      roster,
      leaderState,
      blockList,
      joinPaused: lead !== null && this.#joinPaused?.groupId === lead ? this.#joinPaused : null,
      keepAlive: lead !== null && this.#keepAlive?.groupId === lead ? this.#keepAlive : null,
      isVice:
        this.#vice !== null && this.#vice.groupId === currentGroupId(snapshot) && this.#vice.isVice,
      leadership: this.#leadership,
      lastError: this.#lastError,
      joinFlow: this.#joinFlowOf(snapshot),
      preview: keepPreview(prev.preview, client.preview.getState()),
      storedGroups: this.#storedGroups,
      qr: lead === null ? IDLE_QR : this.qr.state,
    };
    this.#stateLeadGroup = lead;
    if (shallowEqual(prev, next)) return prev;
    this.#state = Object.freeze(next);
    return this.#state;
  }

  /** Always `SERVER_STATE` (AC9). */
  getServerState(): SyncState {
    return SERVER_STATE;
  }

  /** True when the store is over no client (server, before mount, invalid options). */
  get inert(): boolean {
    return this.client === null;
  }

  // ---------------------------------------------------------------------------
  // Mutators used by hooks. All are no-ops on an inert store (R6).
  // ---------------------------------------------------------------------------

  /** Marks the state changed and tells the subscribers. */
  changed(): void {
    if (this.client === null) return;
    this.#dirty = true;
    this.#notify();
  }

  /**
   * Follows a join call for the approval flow (AC17). The outcome of an older
   * call never overwrites a newer one. The promise is observed here, never
   * re-thrown.
   */
  recordJoin(promise: Promise<JoinedGroup>): void {
    if (this.client === null) return;
    this.#flowIds += 1;
    const record: JoinFlowRecord = {
      id: this.#flowIds,
      sawWaiting: false,
      state: Object.freeze({ status: 'joining' as const }),
    };
    this.#flow = record;
    this.changed();
    const settle = (state: JoinFlowState) => {
      if (this.#flow !== record) return;
      record.state = state;
      this.changed();
    };
    promise.then(
      (group) =>
        settle(Object.freeze({ status: record.sawWaiting ? 'approved' : 'joined', group })),
      (error: unknown) => settle(joinFailure(toSyncError(error))),
    );
  }

  /** Back to an idle join flow. */
  resetJoinFlow(): void {
    if (this.client === null) return;
    this.#flowIds += 1;
    this.#flow = { id: this.#flowIds, sawWaiting: false, state: IDLE_JOIN_FLOW };
    this.changed();
  }

  /** Clears the last leadership change (the app showed it). */
  dismissLeadership(): void {
    if (this.client === null || this.#leadership === null) return;
    this.#leadership = null;
    this.changed();
  }

  /** The preview helper changed (it has no subscribe of its own). */
  previewChanged(): void {
    this.changed();
  }

  /** Records the block list an action resolved with, for the group it belongs to (R3). */
  recordBlockList(groupId: string, list: readonly string[]): void {
    const client = this.client;
    if (client === null) return;
    this.#blockList = { groupId, list: Object.freeze([...list]) };
    this.#blockListBase = client.getLeaderState()?.blockList ?? null;
    this.changed();
  }

  /**
   * Checks the stored groups (AC16). Single flight: a second call while one
   * runs gets the same promise. Rejects with the core's error.
   */
  checkStoredGroups(): Promise<readonly StoredGroup[]> {
    const client = this.client;
    if (client === null) return Promise.reject(notConnected());
    if (this.#check !== undefined) return this.#check;
    const check = Promise.resolve()
      .then(() => client.checkTokens())
      .then((statuses) => {
        const groups = Object.freeze(
          statuses.map((status) =>
            Object.freeze({ ...status, availability: availabilityOf(status.status) }),
          ),
        );
        this.#storedGroups = groups;
        this.changed();
        return groups;
      })
      .finally(() => {
        if (this.#check === check) this.#check = undefined;
      });
    this.#check = check;
    return check;
  }

  /**
   * The opt-in automatic check (Q-D): once per connected session, only while
   * attached and connected. Errors are ignored (the app can call `check`).
   */
  checkOnConnect(): void {
    const client = this.client;
    if (client === null || this.#attachCount === 0) return;
    if (client.getSnapshot().connection.status !== 'connected' || this.#sessionChecked) return;
    this.#sessionChecked = true;
    this.checkStoredGroups().catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  readonly #onSnapshot = (): void => {
    const client = this.client;
    if (client === null) return;
    const snapshot = client.getSnapshot();
    if (snapshot !== this.#seen) {
      const before = this.#seen;
      this.#seen = snapshot;
      const connected = snapshot.connection.status === 'connected';
      // lastError is cleared when the connection (re)connects (section 6).
      if (connected && before.connection.status !== 'connected') this.#lastError = null;
      if (!connected) this.#sessionChecked = false;
      if (snapshot.group?.status === 'awaiting_approval' && this.#flow.state.status === 'joining') {
        this.#flow.sawWaiting = true;
      }
      this.#prune(snapshot);
    }
    this.#dirty = true;
    this.qr.evaluate();
    this.#notify();
  };

  #onEvent<E extends (typeof EVENTS)[number]>(event: E, payload: SyncClientEvents[E]): void {
    switch (event) {
      case 'error':
        this.#lastError = payload as SyncClientError;
        break;
      case 'keepAlive':
        this.#keepAlive = payload as KeepAliveEvent;
        break;
      case 'keepAliveCleared':
        this.#keepAlive = null;
        break;
      case 'joinPaused': {
        const paused = payload as SyncClientEvents['joinPaused'];
        this.#joinPaused = Object.freeze({
          groupId: paused.groupId,
          retryAt: now() + finiteOr(paused.retryAfterMs, 0),
        });
        break;
      }
      case 'joinResumed':
        this.#joinPaused = null;
        break;
      case 'codesChanged': {
        const changed = payload as SyncClientEvents['codesChanged'];
        // A rotation lifts a pause (core rotateCodes doc).
        if (changed.reason === 'rotated') this.#joinPaused = null;
        this.qr.codesChanged(changed);
        break;
      }
      case 'viceChanged': {
        const vice = payload as SyncClientEvents['viceChanged'];
        this.#vice = { groupId: vice.groupId, isVice: vice.isVice };
        break;
      }
      case 'nowLeading': {
        const lead = payload as SyncClientEvents['nowLeading'];
        this.#leadership = Object.freeze({
          kind: 'now_leading' as const,
          groupId: lead.groupId,
          reason: lead.reason,
          at: now(),
        });
        // The new leader is not the vice any more.
        this.#vice = null;
        break;
      }
      case 'leadershipLost': {
        const lost = payload as SyncClientEvents['leadershipLost'];
        this.#leadership = Object.freeze({
          kind: 'lost' as const,
          groupId: lost.groupId,
          reason: lost.reason,
          takeBackAvailable: lost.takeBackAvailable,
          at: now(),
        });
        this.#keepAlive = null;
        this.#joinPaused = null;
        break;
      }
      case 'leaderChanged': {
        const changed = payload as SyncClientEvents['leaderChanged'];
        this.#leadership = Object.freeze({
          kind: 'changed' as const,
          groupId: changed.groupId,
          reason: changed.reason,
          at: now(),
        });
        break;
      }
      case 'groupEnded': {
        const ended = payload as GroupEndedInfo;
        this.#dropGroup(ended.groupId);
        break;
      }
      default:
        break;
    }
    this.#dirty = true;
    this.#notify();
  }

  /** Drops event-derived data that does not belong to the current group (R3, Q-C). */
  #prune(snapshot: SyncClientSnapshot): void {
    const lead = leadingGroupId(snapshot);
    const current = currentGroupId(snapshot);
    if (this.#keepAlive !== null && this.#keepAlive.groupId !== lead) this.#keepAlive = null;
    if (this.#joinPaused !== null && this.#joinPaused.groupId !== lead) this.#joinPaused = null;
    if (this.#vice !== null && this.#vice.groupId !== current) this.#vice = null;
    if (this.#leadership !== null && this.#leadership.groupId !== current) this.#leadership = null;
    if (this.#blockList !== null && this.#blockList.groupId !== lead) {
      this.#blockList = null;
      this.#blockListBase = null;
    }
  }

  #dropGroup(groupId: string): void {
    if (this.#keepAlive?.groupId === groupId) this.#keepAlive = null;
    if (this.#joinPaused?.groupId === groupId) this.#joinPaused = null;
    if (this.#vice?.groupId === groupId) this.#vice = null;
    if (this.#leadership?.groupId === groupId) this.#leadership = null;
    if (this.#blockList?.groupId === groupId) {
      this.#blockList = null;
      this.#blockListBase = null;
    }
  }

  /**
   * The block list of the group this client leads: an action's result while
   * the core's list has not changed since, else the core's recovery state.
   */
  #blockListFor(
    lead: string,
    leaderState: LeaderState | null,
    prev: readonly string[],
  ): readonly string[] {
    const core = leaderState?.blockList ?? null;
    let list: readonly string[];
    if (this.#blockList?.groupId === lead && sameStrings(core, this.#blockListBase)) {
      list = this.#blockList.list;
    } else {
      this.#blockList = null;
      this.#blockListBase = null;
      list = core ?? EMPTY_LIST;
    }
    return sameStrings(prev, list) ? prev : list;
  }

  #joinFlowOf(snapshot: SyncClientSnapshot): JoinFlowState {
    const group = snapshot.group;
    if (group?.status === 'awaiting_approval') {
      const waiting = this.#waiting;
      if (
        waiting !== null &&
        waiting.requestId === group.requestId &&
        waiting.expiresAt === group.expiresAt
      ) {
        return waiting;
      }
      this.#waiting = Object.freeze({
        status: 'waiting' as const,
        requestId: group.requestId,
        expiresAt: group.expiresAt,
      });
      return this.#waiting;
    }
    this.#waiting = null;
    return this.#flow.state;
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/** The store over no client: what every hook reads on the server and before mount (R6). */
export const EMPTY_STORE = new SyncStore(null);

function notConnected(): SyncClientError {
  return toSyncError(undefined, 'NOT_CONNECTED');
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Maps a failed join to the flow state (AC17, Q-B). */
function joinFailure(error: SyncClientError): JoinFlowState {
  switch (error.code) {
    case 'JOIN_PAUSED': {
      const after = (error as SyncClientError<'JOIN_PAUSED'>).details?.retryAfterMs;
      return Object.freeze({
        status: 'paused' as const,
        retryAt: typeof after === 'number' && Number.isFinite(after) ? now() + after : undefined,
      });
    }
    case 'JOIN_DENIED':
      return Object.freeze({ status: 'denied' as const });
    case 'JOIN_CANCELLED':
      return Object.freeze({ status: 'withdrawn' as const, reason: 'cancelled' as const });
    case 'APPROVAL_TIMEOUT':
      return Object.freeze({ status: 'withdrawn' as const, reason: 'timeout' as const });
    default:
      return Object.freeze({ status: 'failed' as const, error });
  }
}

function shallowEqual(a: SyncState, b: SyncState): boolean {
  for (const key of Object.keys(b) as (keyof SyncState)[]) {
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

function keepCodes(prev: JoinCodes | null, next: JoinCodes | null): JoinCodes | null {
  if (prev === null || next === null) return next;
  return prev.generation === next.generation &&
    prev.groupCode === next.groupCode &&
    prev.doorCode === next.doorCode &&
    prev.alphaCode === next.alphaCode
    ? prev
    : next;
}

function keepList<T>(
  prev: readonly T[],
  next: readonly T[],
  same: (a: T, b: T) => boolean,
): readonly T[] {
  if (next.length === 0) return EMPTY_LIST;
  if (prev.length !== next.length) return next;
  for (let i = 0; i < next.length; i += 1) {
    if (!same(prev[i] as T, next[i] as T)) return next;
  }
  return prev;
}

function sameRequest(a: JoinRequest, b: JoinRequest): boolean {
  return (
    a === b ||
    (a.requestId === b.requestId && a.displayName === b.displayName && a.expiresAt === b.expiresAt)
  );
}

function sameRosterEntry(a: RosterEntry, b: RosterEntry): boolean {
  return (
    a === b ||
    (a.participantId === b.participantId &&
      a.displayName === b.displayName &&
      a.generated === b.generated &&
      a.guestNumber === b.guestNumber &&
      a.role === b.role &&
      a.connected === b.connected &&
      a.joinedAt === b.joinedAt &&
      a.admittedSinceRecovery === b.admittedSinceRecovery)
  );
}

function sameStrings(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.length !== b.length) return false;
  return a.every((value, i) => value === b[i]);
}

function keepLeaderState(prev: LeaderState | null, next: LeaderState | null): LeaderState | null {
  if (prev === null || next === null) return next;
  return prev.locked === next.locked &&
    prev.viceId === next.viceId &&
    prev.handoff === next.handoff &&
    sameStrings(prev.blockList, next.blockList)
    ? prev
    : next;
}

function keepPreview(prev: PreviewState, next: PreviewState): PreviewState {
  if (
    prev.active === next.active &&
    Object.is(prev.groupPosition, next.groupPosition) &&
    Object.is(prev.previewPosition, next.previewPosition)
  ) {
    return prev;
  }
  return !next.active && next.groupPosition === undefined ? IDLE_PREVIEW : next;
}
