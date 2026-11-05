import {
  type ConnectedInfo,
  type ConnectionState,
  type CreatedGroup,
  type GroupState,
  type JoinCodes,
  type JoinedGroup,
  type JoinRequest,
  type JsonValue,
  LeaderPreview,
  type LeaderState,
  type QrTicket,
  type ResumedGroup,
  type RosterEntry,
  type StoredGroupStatus,
  SyncClientError,
  type SyncClientEvents,
  type SyncClientSnapshot,
} from '@sync-system/client';
import type { SyncClientLike } from '../../src/types.js';

export type Method = Exclude<
  keyof SyncClientLike,
  | 'getState'
  | 'getSnapshot'
  | 'subscribe'
  | 'on'
  | 'off'
  | 'getJoinCodes'
  | 'getJoinRequests'
  | 'getRoster'
  | 'getLeaderState'
  | 'preview'
>;

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const CONNECTED: ConnectionState = Object.freeze({
  status: 'connected' as const,
  participantId: 'p-self',
  namespace: 'app-test',
  joinMethods: Object.freeze(['A', 'C', 'D'] as const),
  limits: Object.freeze({
    maxGroupSize: 50,
    maxLeaderUpdatesPerSecond: 5,
    maxMessageBytes: 16384,
  }) as never,
});

type ActiveGroup = Extract<GroupState, { status: 'active' }>;

/** An active group snapshot part. */
export function activeGroup(
  role: 'leader' | 'member',
  groupId = 'g-1',
  extra: Partial<ActiveGroup> = {},
): ActiveGroup {
  return Object.freeze({
    status: 'active' as const,
    groupId,
    role,
    metadata: {},
    hasPosition: false,
    position: undefined,
    leaderOnline: true,
    displayName: 'Guest 1',
    generated: true,
    locked: false,
    leader: { status: 'online' as const },
    takeBackAvailable: false,
    ...extra,
  });
}

/**
 * A controllable `SyncClientLike` (section 4): a settable snapshot, `emit()`,
 * per-method implementations (default: a pending promise kept in `pending`),
 * call records, and a real `LeaderPreview` over the fake.
 */
export class FakeSyncClient implements SyncClientLike {
  snapshot: SyncClientSnapshot = Object.freeze({
    connection: Object.freeze({ status: 'idle' as const }),
    group: null,
  });
  codes: JoinCodes | null = null;
  requests: readonly JoinRequest[] = [];
  roster: readonly RosterEntry[] = [];
  leaderState: LeaderState | null = null;
  readonly calls = new Map<string, unknown[][]>();
  readonly impl: Partial<Record<Method, (...args: never[]) => unknown>> = {};
  readonly pending = new Map<string, Deferred<unknown>[]>();
  readonly #subscribers = new Set<() => void>();
  readonly #events = new Map<string, Set<(payload: never) => void>>();
  readonly sentActivity: number[] = [];

  readonly preview: LeaderPreview = new LeaderPreview({
    isLeader: () => this.#group()?.role === 'leader',
    groupPosition: () => {
      const group = this.#group();
      return group?.hasPosition ? group.position : undefined;
    },
    updatePosition: (position) => this.updatePosition(position),
    sendActivity: () => {
      this.sentActivity.push(Date.now());
      return Promise.resolve();
    },
  });

  // ---- test controls ----

  setSnapshot(change: Partial<SyncClientSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...change });
    for (const listener of [...this.#subscribers]) listener();
  }

  setConnection(connection: ConnectionState): void {
    this.setSnapshot({ connection });
  }

  setGroup(group: GroupState | null): void {
    this.setSnapshot({ group });
  }

  /** Connected, leading `groupId`. */
  lead(groupId = 'g-1', extra: Partial<ActiveGroup> = {}): void {
    this.setSnapshot({ connection: CONNECTED, group: activeGroup('leader', groupId, extra) });
  }

  /** Connected, a member of `groupId`. */
  follow(groupId = 'g-1', extra: Partial<ActiveGroup> = {}): void {
    this.setSnapshot({ connection: CONNECTED, group: activeGroup('member', groupId, extra) });
  }

  emit<E extends keyof SyncClientEvents>(event: E, payload: SyncClientEvents[E]): void {
    for (const listener of [...(this.#events.get(event) ?? [])]) listener(payload as never);
  }

  count(method: string): number {
    return this.calls.get(method)?.length ?? 0;
  }

  listenerCount(event?: keyof SyncClientEvents): number {
    if (event !== undefined) return this.#events.get(event)?.size ?? 0;
    let total = 0;
    for (const set of this.#events.values()) total += set.size;
    return total;
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /** The last pending promise of `method` (default implementation). */
  lastPending(method: Method): Deferred<unknown> {
    const last = this.pending.get(method)?.at(-1);
    if (!last) throw new Error(`no pending ${method}`);
    return last;
  }

  // ---- SyncClientLike ----

  getState(): ConnectionState {
    return this.snapshot.connection;
  }

  getSnapshot(): SyncClientSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.#subscribers.add(listener);
    return () => {
      this.#subscribers.delete(listener);
    };
  }

  on<E extends keyof SyncClientEvents>(
    event: E,
    listener: (payload: SyncClientEvents[E]) => void,
  ): () => void {
    let set = this.#events.get(event);
    if (!set) {
      set = new Set();
      this.#events.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  off<E extends keyof SyncClientEvents>(
    event: E,
    listener: (payload: SyncClientEvents[E]) => void,
  ): void {
    this.#events.get(event)?.delete(listener);
  }

  getJoinCodes(): JoinCodes | null {
    return this.#group()?.role === 'leader' ? this.codes : null;
  }

  getJoinRequests(): readonly JoinRequest[] {
    return Object.freeze([...this.requests]);
  }

  getRoster(): readonly RosterEntry[] {
    return Object.freeze([...this.roster]);
  }

  getLeaderState(): LeaderState | null {
    return this.leaderState === null
      ? null
      : Object.freeze({ ...this.leaderState, blockList: [...this.leaderState.blockList] });
  }

  /** Like the core: `connecting` at once, unless already connecting or connected. */
  connect(): Promise<ConnectedInfo> {
    const status = this.snapshot.connection.status;
    const result = this.#call<ConnectedInfo>('connect', []);
    if (status === 'idle' || status === 'closed') this.setConnection({ status: 'connecting' });
    return result;
  }
  close(): void {
    this.#record('close', []);
    this.impl.close?.();
  }
  createGroup(...args: Parameters<SyncClientLike['createGroup']>): Promise<CreatedGroup> {
    return this.#call('createGroup', args);
  }
  joinByCode(...args: Parameters<SyncClientLike['joinByCode']>): Promise<JoinedGroup> {
    return this.#call('joinByCode', args);
  }
  joinByQr(...args: Parameters<SyncClientLike['joinByQr']>): Promise<JoinedGroup> {
    return this.#call('joinByQr', args);
  }
  cancelJoin(): Promise<void> {
    return this.#call('cancelJoin', []);
  }
  checkTokens(): Promise<readonly StoredGroupStatus[]> {
    return this.#call('checkTokens', []);
  }
  resumeGroup(...args: Parameters<SyncClientLike['resumeGroup']>): Promise<ResumedGroup> {
    return this.#call('resumeGroup', args);
  }
  endGroup(): Promise<void> {
    return this.#call('endGroup', []);
  }
  leaveGroup(): Promise<void> {
    return this.#call('leaveGroup', []);
  }
  updatePosition(position: JsonValue): void {
    this.#record('updatePosition', [position]);
    const impl = this.impl.updatePosition as ((p: JsonValue) => void) | undefined;
    if (impl) {
      impl(position);
      return;
    }
    const group = this.#group();
    if (this.snapshot.connection.status !== 'connected') throw new SyncClientError('NOT_CONNECTED');
    if (!group) throw new SyncClientError('NOT_IN_GROUP');
    if (group.role !== 'leader') {
      throw new SyncClientError('NOT_LEADER', { request: 'position.update' });
    }
    this.setGroup({ ...group, hasPosition: true, position });
  }
  rotateCodes(): Promise<JoinCodes> {
    return this.#call('rotateCodes', []);
  }
  issueQrTicket(): Promise<QrTicket> {
    return this.#call('issueQrTicket', []);
  }
  approveJoin(requestId: string): Promise<'admitted' | 'group_full'> {
    return this.#call('approveJoin', [requestId]);
  }
  denyJoin(requestId: string): Promise<void> {
    return this.#call('denyJoin', [requestId]);
  }
  setViceLeader(participantId: string): Promise<string> {
    return this.#call('setViceLeader', [participantId]);
  }
  clearViceLeader(): Promise<void> {
    return this.#call('clearViceLeader', []);
  }
  lockGroup(): Promise<void> {
    return this.#call('lockGroup', []);
  }
  unlockGroup(): Promise<void> {
    return this.#call('unlockGroup', []);
  }
  removeMember(participantId: string): Promise<readonly string[]> {
    return this.#call('removeMember', [participantId]);
  }
  getBlockList(groupId: string): Promise<readonly string[]> {
    return this.#call('getBlockList', [groupId]);
  }
  addToBlockList(groupId: string, participantIds: readonly string[]): Promise<readonly string[]> {
    return this.#call('addToBlockList', [groupId, participantIds]);
  }
  answerKeepAlive(): Promise<void> {
    return this.#call('answerKeepAlive', []);
  }
  takeBackLeadership(): Promise<void> {
    return this.#call('takeBackLeadership', []);
  }

  // ---- internals ----

  #group(): ActiveGroup | undefined {
    const group = this.snapshot.group;
    return group?.status === 'active' ? group : undefined;
  }

  #record(method: string, args: unknown[]): void {
    let list = this.calls.get(method);
    if (!list) {
      list = [];
      this.calls.set(method, list);
    }
    list.push(args);
  }

  #call<T>(method: Method, args: unknown[]): Promise<T> {
    this.#record(method, args);
    const impl = this.impl[method] as ((...a: unknown[]) => unknown) | undefined;
    if (impl) {
      // A throwing implementation rejects, like the core's local errors.
      return new Promise<T>((resolve) => resolve(impl(...args) as T));
    }
    const d = deferred<unknown>();
    let list = this.pending.get(method);
    if (!list) {
      list = [];
      this.pending.set(method, list);
    }
    list.push(d);
    return d.promise as Promise<T>;
  }
}
