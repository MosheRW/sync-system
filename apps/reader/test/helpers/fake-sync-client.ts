import {
  type ConnectedInfo,
  type ConnectionState,
  type CreatedGroup,
  type GroupState,
  type JoinCodes,
  type JoinedGroup,
  type JoinRequest,
  type JsonValue,
  type LeaderState,
  type QrTicket,
  type ResumedGroup,
  type RosterEntry,
  type StoredGroupStatus,
  type SyncClientEvents,
  type SyncClientLike,
  type SyncClientSnapshot,
  SyncClientError,
} from '@sync-system/react';

type Method = keyof SyncClientLike;

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
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

export const LIMITS = Object.freeze({
  maxGroupSize: 50,
  maxLeaderUpdatesPerSecond: 5,
  maxMessageBytes: 4096,
  maxSessionMinutes: 120,
  qrTicketSeconds: 300,
  approvalTimeoutSeconds: 120,
  inactivityLimitMinutes: 20,
  disconnectGraceSeconds: 30,
  keepAliveCountdownSeconds: 60,
});

export function connected(
  joinMethods: readonly ('A' | 'B' | 'C' | 'D')[] = ['A', 'B', 'C', 'D'],
  defaultHandoff: 'auto' | 'frozen' = 'auto',
): ConnectionState {
  return Object.freeze({
    status: 'connected' as const,
    participantId: 'p-self',
    namespace: 'dev-app',
    joinMethods: Object.freeze([...joinMethods]),
    limits: LIMITS,
    defaultHandoff,
  });
}

/** A real-looking group ID (43 base64url characters). */
export const GROUP_ID = 'G'.repeat(43);
export const OTHER_GROUP_ID = 'H'.repeat(43);

type ActiveGroup = Extract<GroupState, { status: 'active' }>;

export function activeGroup(
  role: 'leader' | 'member',
  extra: Partial<ActiveGroup> = {},
): ActiveGroup {
  return Object.freeze({
    status: 'active' as const,
    groupId: GROUP_ID,
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
 * A scripted `SyncClientLike` for the reader's component tests: a settable
 * snapshot, `emit()`, per-method implementations (default: a pending promise
 * kept in `pending`) and call records. `preview.move()` only records: a
 * preview never reaches members (#13 AC30).
 */
export class FakeSyncClient implements SyncClientLike {
  snapshot: SyncClientSnapshot = Object.freeze({
    connection: Object.freeze({ status: 'idle' as const }),
    group: null,
  });
  codes: JoinCodes | null = null;
  requests: readonly JoinRequest[] = [];
  readonly calls = new Map<string, unknown[][]>();
  readonly impl: Partial<Record<Method, (...args: never[]) => unknown>> = {};
  readonly pending = new Map<string, Deferred<unknown>[]>();
  readonly #subscribers = new Set<() => void>();
  readonly #events = new Map<string, Set<(payload: never) => void>>();
  readonly previewMoves: number[] = [];

  #previewActive = false;
  #previewPosition: JsonValue | undefined;

  /** Like the core's LeaderPreview: local only, the group position never changes. */
  readonly preview = {
    start: (position?: JsonValue) => {
      this.#previewActive = true;
      this.#previewPosition = position;
    },
    move: (position: JsonValue) => {
      if (!this.#previewActive) return;
      this.#previewPosition = position;
      this.previewMoves.push(position as number);
    },
    end: () => {
      this.#previewActive = false;
      this.#previewPosition = undefined;
    },
    bringGroupHere: () => undefined,
    returnToGroup: () => undefined,
    getState: () =>
      Object.freeze({
        active: this.#previewActive,
        groupPosition: undefined,
        previewPosition: this.#previewActive ? this.#previewPosition : undefined,
      }),
  } as unknown as SyncClientLike['preview'];

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

  /** Connected, leading. */
  lead(extra: Partial<ActiveGroup> = {}, connection = connected()): void {
    this.setSnapshot({ connection, group: activeGroup('leader', extra) });
  }

  /** Connected, a member. */
  follow(extra: Partial<ActiveGroup> = {}, connection = connected()): void {
    this.setSnapshot({ connection, group: activeGroup('member', extra) });
  }

  /** Changes the active group in place. */
  patchGroup(extra: Partial<ActiveGroup>): void {
    const group = this.snapshot.group;
    if (group?.status !== 'active') throw new Error('no active group');
    this.setGroup(Object.freeze({ ...group, ...extra }));
  }

  emit<E extends keyof SyncClientEvents>(event: E, payload: SyncClientEvents[E]): void {
    for (const listener of [...(this.#events.get(event) ?? [])]) listener(payload as never);
  }

  count(method: string): number {
    return this.calls.get(method)?.length ?? 0;
  }

  args(method: string, call = -1): unknown[] {
    const list = this.calls.get(method) ?? [];
    const found = list.at(call);
    if (!found) throw new Error(`no call to ${method}`);
    return found;
  }

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
    const group = this.snapshot.group;
    return group?.status === 'active' && group.role === 'leader' ? this.codes : null;
  }

  getJoinRequests(): readonly JoinRequest[] {
    return Object.freeze([...this.requests]);
  }

  getRoster(): readonly RosterEntry[] {
    return [];
  }

  getLeaderState(): LeaderState | null {
    return null;
  }

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
    const group = this.snapshot.group;
    if (this.snapshot.connection.status !== 'connected') throw new SyncClientError('NOT_CONNECTED');
    if (group?.status !== 'active') throw new SyncClientError('NOT_IN_GROUP');
    if (group.role !== 'leader') {
      throw new SyncClientError('NOT_LEADER', { request: 'position.update' });
    }
    this.setGroup(Object.freeze({ ...group, hasPosition: true, position }));
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
    if (impl) return new Promise<T>((resolve) => resolve(impl(...args) as T));
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
