import { SyncClientError } from '@sync-system/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDLE_SNAPSHOT, SERVER_STATE } from '../src/server-state.js';
import { EMPTY_STORE, SyncStore, availabilityOf } from '../src/store.js';
import { updateRequiredOf } from '../src/update-required.js';
import { CONNECTED, FakeSyncClient, activeGroup } from './helpers/fake-client.js';

afterEach(() => {
  vi.useRealTimers();
});

const CODES = Object.freeze({ generation: 1, groupCode: '123456', alphaCode: 'ABCDEFGH' });
const ROSTER = [
  Object.freeze({
    participantId: 'p-1',
    displayName: 'Ana',
    generated: false,
    role: 'member' as const,
    connected: true,
    joinedAt: 1,
  }),
];
const REQUESTS = [Object.freeze({ requestId: 'r-1', displayName: 'Bo', expiresAt: 5 })];
const LEADER_STATE = Object.freeze({
  blockList: ['p-9'],
  locked: false,
  handoff: 'auto' as const,
});

/** A store over a fake that leads `g-1` with codes, roster, requests and state. */
function leadingStore(): { client: FakeSyncClient; store: SyncStore; detach: () => void } {
  const client = new FakeSyncClient();
  client.codes = CODES;
  client.roster = ROSTER;
  client.requests = REQUESTS;
  client.leaderState = LEADER_STATE;
  const store = new SyncStore(client);
  const detach = store.attach();
  client.lead('g-1');
  return { client, store, detach };
}

/** Every leader-only part is empty (R3). */
function expectNoLeaderData(store: SyncStore): void {
  const state = store.getState();
  expect(state.codes).toBeNull();
  expect(state.roster).toEqual([]);
  expect(state.joinRequests).toEqual([]);
  expect(state.leaderState).toBeNull();
  expect(state.blockList).toEqual([]);
  expect(state.keepAlive).toBeNull();
  expect(state.joinPaused).toBeNull();
  expect(state.qr).toEqual({ status: 'idle' });
}

describe('SyncStore snapshot (D2)', () => {
  it('keeps the same state object until something changes', () => {
    const { client, store } = leadingStore();
    const first = store.getState();
    expect(store.getState()).toBe(first);
    expect(first.snapshot).toBe(client.snapshot);
    client.setConnection({ status: 'connecting' });
    const second = store.getState();
    expect(second).not.toBe(first);
    expect(second.snapshot).toBe(client.snapshot);
  });

  it('keeps the identity of equal leader-only parts across rebuilds', () => {
    const { client, store } = leadingStore();
    const first = store.getState();
    client.emit('rosterChanged', { groupId: 'g-1', roster: ROSTER });
    client.emit('codesChanged', { groupId: 'g-1', codes: CODES, reason: 'door_failures' });
    const second = store.getState();
    expect(second).toBe(first);
    client.roster = [...ROSTER, { ...ROSTER[0]!, participantId: 'p-2' }];
    client.emit('rosterChanged', { groupId: 'g-1', roster: client.roster });
    const third = store.getState();
    expect(third.roster).not.toBe(first.roster);
    expect(third.roster).toHaveLength(2);
    expect(third.codes).toBe(first.codes);
    expect(third.joinRequests).toBe(first.joinRequests);
    expect(third.leaderState).toBe(first.leaderState);
  });

  it('reads the leader-only data while leading', () => {
    const { store } = leadingStore();
    const state = store.getState();
    expect(state.codes).toEqual(CODES);
    expect(state.roster).toEqual(ROSTER);
    expect(state.joinRequests).toEqual(REQUESTS);
    expect(state.leaderState).toEqual(LEADER_STATE);
    expect(state.blockList).toEqual(['p-9']);
  });

  it('is deep-frozen', () => {
    const { store } = leadingStore();
    const state = store.getState();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(SERVER_STATE)).toBe(true);
    expect(Object.isFrozen(SERVER_STATE.snapshot)).toBe(true);
    expect(Object.isFrozen(SERVER_STATE.snapshot.connection)).toBe(true);
    expect(Object.isFrozen(SERVER_STATE.joinRequests)).toBe(true);
    expect(Object.isFrozen(SERVER_STATE.preview)).toBe(true);
    expect(Object.isFrozen(SERVER_STATE.joinFlow)).toBe(true);
    expect(Object.isFrozen(SERVER_STATE.qr)).toBe(true);
  });

  it('getServerState is always the one constant', () => {
    const { store } = leadingStore();
    expect(store.getServerState()).toBe(SERVER_STATE);
    expect(EMPTY_STORE.getServerState()).toBe(SERVER_STATE);
    expect(SERVER_STATE.snapshot).toBe(IDLE_SNAPSHOT);
  });
});

describe('leader-only data never outlives the role (R3, M3)', () => {
  function withEventState(): ReturnType<typeof leadingStore> {
    const setup = leadingStore();
    setup.client.emit('keepAlive', { groupId: 'g-1', countdownMs: 1000, deadlineAt: 2 });
    setup.client.emit('joinPaused', { groupId: 'g-1', retryAfterMs: 1000 });
    setup.store.recordBlockList('g-1', ['p-9', 'p-8']);
    const state = setup.store.getState();
    expect(state.keepAlive).not.toBeNull();
    expect(state.joinPaused).not.toBeNull();
    expect(state.blockList).toEqual(['p-9', 'p-8']);
    return setup;
  }

  it('drops everything on demotion (leadershipLost)', () => {
    const { client, store } = withEventState();
    client.follow('g-1');
    client.emit('leadershipLost', {
      groupId: 'g-1',
      reason: 'superseded',
      takeBackAvailable: false,
    });
    expectNoLeaderData(store);
    expect(store.getState().leadership).toMatchObject({ kind: 'lost', reason: 'superseded' });
  });

  it('drops everything on removal (close 4004)', () => {
    const { client, store } = withEventState();
    client.emit('removed', { groupId: 'g-1' });
    client.setSnapshot({
      connection: { status: 'closed', reason: 'removed', error: new SyncClientError('REMOVED') },
      group: { status: 'ended', groupId: 'g-1', reason: 'removed' },
    });
    expectNoLeaderData(store);
  });

  it('drops everything when the group ends', () => {
    const { client, store } = withEventState();
    client.setGroup({ status: 'ended', groupId: 'g-1', reason: 'ended_by_leader' });
    client.emit('groupEnded', { groupId: 'g-1', reason: 'ended_by_leader' });
    expectNoLeaderData(store);
  });

  it('keeps nothing of group A when leading group B', () => {
    const { client, store } = withEventState();
    const before = store.getState();
    client.codes = { ...CODES };
    client.lead('g-2');
    const after = store.getState();
    expect(after.keepAlive).toBeNull();
    expect(after.joinPaused).toBeNull();
    // The core's (fake's) data for B: same content, never A's cached objects.
    expect(after.codes).not.toBe(before.codes);
    expect(after.roster).not.toBe(before.roster);
    expect(after.leaderState).not.toBe(before.leaderState);
    expect(after.blockList).toEqual(['p-9']);
  });

  it('returns null while the core returns null, never a cached value', () => {
    const { client, store } = leadingStore();
    expect(store.getState().codes).not.toBeNull();
    client.codes = null;
    client.leaderState = null;
    client.roster = [];
    client.requests = [];
    store.changed();
    const state = store.getState();
    expect(state.codes).toBeNull();
    expect(state.leaderState).toBeNull();
    expect(state.roster).toEqual([]);
    expect(state.joinRequests).toEqual([]);
  });

  it('hides leader data while the group is rejoining', () => {
    const { client, store } = leadingStore();
    client.setGroup({
      status: 'rejoining',
      groupId: 'g-1',
      role: 'leader',
      metadata: null,
      hasPosition: false,
      position: undefined,
    });
    expectNoLeaderData(store);
  });
});

describe('event-derived state (D11)', () => {
  it('sets and clears the keep-alive prompt', () => {
    const { client, store } = leadingStore();
    client.emit('keepAlive', { groupId: 'g-1', countdownMs: 1000, deadlineAt: 2 });
    expect(store.getState().keepAlive).toEqual({
      groupId: 'g-1',
      countdownMs: 1000,
      deadlineAt: 2,
    });
    client.emit('keepAliveCleared', { groupId: 'g-1' });
    expect(store.getState().keepAlive).toBeNull();
  });

  it('ignores a keep-alive prompt for another group', () => {
    const { client, store } = leadingStore();
    client.emit('keepAlive', { groupId: 'g-other', countdownMs: 1000, deadlineAt: 2 });
    expect(store.getState().keepAlive).toBeNull();
  });

  it('tracks the join pause until resumed or rotated', () => {
    vi.useFakeTimers({ now: 1_000 });
    const { client, store } = leadingStore();
    client.emit('joinPaused', { groupId: 'g-1', retryAfterMs: 5_000 });
    expect(store.getState().joinPaused).toEqual({ groupId: 'g-1', retryAt: 6_000 });
    client.emit('joinResumed', { groupId: 'g-1' });
    expect(store.getState().joinPaused).toBeNull();
    client.emit('joinPaused', { groupId: 'g-1', retryAfterMs: Number.NaN });
    expect(store.getState().joinPaused).toEqual({ groupId: 'g-1', retryAt: 1_000 });
    client.emit('codesChanged', { groupId: 'g-1', codes: CODES, reason: 'rotated' });
    expect(store.getState().joinPaused).toBeNull();
  });

  it('tracks the member vice flag and resets it on group change or end (Q-C)', () => {
    const client = new FakeSyncClient();
    const store = new SyncStore(client);
    store.attach();
    client.follow('g-1');
    client.emit('viceChanged', { groupId: 'g-1', isVice: true });
    expect(store.getState().isVice).toBe(true);
    client.emit('viceChanged', { groupId: 'g-1', isVice: false });
    expect(store.getState().isVice).toBe(false);
    client.emit('viceChanged', { groupId: 'g-1', isVice: true });
    client.follow('g-2');
    expect(store.getState().isVice).toBe(false);
    client.follow('g-1');
    expect(store.getState().isVice).toBe(false);
    client.emit('viceChanged', { groupId: 'g-1', isVice: true });
    client.setGroup({ status: 'ended', groupId: 'g-1', reason: 'ended_by_leader' });
    expect(store.getState().isVice).toBe(false);
  });

  it('records leadership changes and dismisses them', () => {
    vi.useFakeTimers({ now: 50 });
    const client = new FakeSyncClient();
    const store = new SyncStore(client);
    store.attach();
    client.follow('g-1');
    client.emit('leaderChanged', { groupId: 'g-1', reason: 'handoff_disconnect' });
    expect(store.getState().leadership).toEqual({
      kind: 'changed',
      groupId: 'g-1',
      reason: 'handoff_disconnect',
      at: 50,
    });
    client.lead('g-1');
    client.emit('nowLeading', { groupId: 'g-1', reason: 'handoff_disconnect' });
    expect(store.getState().leadership).toMatchObject({ kind: 'now_leading' });
    store.dismissLeadership();
    expect(store.getState().leadership).toBeNull();
  });

  it('keeps the last error until the connection reconnects', () => {
    const { client, store } = leadingStore();
    const error = new SyncClientError('RATE_LIMITED');
    client.emit('error', error);
    expect(store.getState().lastError).toBe(error);
    client.setConnection({ status: 'connecting' });
    expect(store.getState().lastError).toBe(error);
    client.setConnection(CONNECTED);
    expect(store.getState().lastError).toBeNull();
  });

  it('notifies subscribers on snapshot changes and events', () => {
    const { client, store } = leadingStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    client.setConnection({ status: 'connecting' });
    client.emit('rosterChanged', { groupId: 'g-1', roster: ROSTER });
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    client.setConnection(CONNECTED);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('attach is ref-counted and detach removes every listener', () => {
    const client = new FakeSyncClient();
    const store = new SyncStore(client);
    const a = store.attach();
    const b = store.attach();
    const listeners = client.listenerCount();
    expect(listeners).toBeGreaterThan(10);
    expect(client.subscriberCount).toBe(1);
    a();
    a();
    expect(client.listenerCount()).toBe(listeners);
    b();
    expect(client.listenerCount()).toBe(0);
    expect(client.subscriberCount).toBe(0);
  });
});

describe('join flow (AC17, Q-B)', () => {
  function storeWithClient(): { client: FakeSyncClient; store: SyncStore } {
    const client = new FakeSyncClient();
    const store = new SyncStore(client);
    store.attach();
    client.setConnection(CONNECTED);
    return { client, store };
  }

  const JOINED = Object.freeze({
    groupId: 'g-1',
    role: 'member' as const,
    participantId: 'p-1',
    metadata: {},
    hasPosition: false,
  });

  it('joining -> joined', async () => {
    const { store } = storeWithClient();
    store.recordJoin(Promise.resolve(JOINED));
    expect(store.getState().joinFlow).toEqual({ status: 'joining' });
    await Promise.resolve();
    expect(store.getState().joinFlow).toEqual({ status: 'joined', group: JOINED });
  });

  it('waiting (from the snapshot) -> approved', async () => {
    const { client, store } = storeWithClient();
    let admit!: (group: typeof JOINED) => void;
    store.recordJoin(new Promise((resolve) => (admit = resolve)));
    client.setGroup({ status: 'awaiting_approval', requestId: 'r-1', expiresAt: 9 });
    const waiting = store.getState().joinFlow;
    expect(waiting).toEqual({ status: 'waiting', requestId: 'r-1', expiresAt: 9 });
    client.setConnection({ ...CONNECTED });
    expect(store.getState().joinFlow).toBe(waiting);
    client.setGroup(activeGroup('member'));
    admit(JOINED);
    await Promise.resolve();
    expect(store.getState().joinFlow).toEqual({ status: 'approved', group: JOINED });
  });

  it.each([
    [
      new SyncClientError('JOIN_PAUSED', { details: { retryAfterMs: 1000 } }),
      { status: 'paused', retryAt: 1_001_000 },
    ],
    [new SyncClientError('JOIN_PAUSED'), { status: 'paused', retryAt: undefined }],
    [new SyncClientError('JOIN_DENIED'), { status: 'denied' }],
    [new SyncClientError('JOIN_CANCELLED'), { status: 'withdrawn', reason: 'cancelled' }],
    [new SyncClientError('APPROVAL_TIMEOUT'), { status: 'withdrawn', reason: 'timeout' }],
  ])('maps %s', async (error, expected) => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { store } = storeWithClient();
    store.recordJoin(Promise.reject(error));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState().joinFlow).toEqual(expected);
  });

  it('other errors fail with the typed error; non-SyncClientErrors become INTERNAL_ERROR', async () => {
    const { store } = storeWithClient();
    const error = new SyncClientError('CODE_NOT_FOUND');
    store.recordJoin(Promise.reject(error));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().joinFlow).toEqual({ status: 'failed', error });
    store.recordJoin(Promise.reject(new Error('app data')));
    await Promise.resolve();
    await Promise.resolve();
    const flow = store.getState().joinFlow;
    expect(flow.status === 'failed' && flow.error.code).toBe('INTERNAL_ERROR');
  });

  it('an older join outcome never overwrites a newer one', async () => {
    const { store } = storeWithClient();
    let first!: (group: typeof JOINED) => void;
    store.recordJoin(new Promise((resolve) => (first = resolve)));
    store.recordJoin(Promise.reject(new SyncClientError('JOIN_DENIED')));
    await Promise.resolve();
    await Promise.resolve();
    first(JOINED);
    await Promise.resolve();
    expect(store.getState().joinFlow).toEqual({ status: 'denied' });
    store.resetJoinFlow();
    expect(store.getState().joinFlow).toEqual({ status: 'idle' });
  });
});

describe('stored groups (AC16)', () => {
  it('maps all seven statuses to availability', () => {
    expect(availabilityOf('live')).toBe('live');
    expect(availabilityOf('recoverable')).toBe('resumable');
    expect(availabilityOf('waiting')).toBe('resumable');
    for (const status of ['blocked', 'ended', 'expired', 'invalid'] as const) {
      expect(availabilityOf(status)).toBe('gone');
    }
  });

  it('checks once at a time and stores the result', async () => {
    const client = new FakeSyncClient();
    const store = new SyncStore(client);
    store.attach();
    client.setConnection(CONNECTED);
    const a = store.checkStoredGroups();
    const b = store.checkStoredGroups();
    expect(b).toBe(a);
    await Promise.resolve();
    expect(client.count('checkTokens')).toBe(1);
    client
      .lastPending('checkTokens')
      .resolve([{ groupId: 'g-1', role: 'member', status: 'ended' }]);
    await expect(a).resolves.toEqual([
      { groupId: 'g-1', role: 'member', status: 'ended', availability: 'gone' },
    ]);
    expect(store.getState().storedGroups).toEqual([
      { groupId: 'g-1', role: 'member', status: 'ended', availability: 'gone' },
    ]);
  });

  it('checkOnConnect checks once per connected session (Q-D)', async () => {
    const client = new FakeSyncClient();
    client.impl.checkTokens = () => Promise.resolve([]);
    const store = new SyncStore(client);
    store.checkOnConnect();
    store.attach();
    store.checkOnConnect();
    client.setConnection(CONNECTED);
    store.checkOnConnect();
    store.checkOnConnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.count('checkTokens')).toBe(1);
    client.setConnection({
      status: 'reconnecting',
      attempt: 1,
      delayMs: 1,
      retryAt: 1,
      attempting: false,
    });
    client.setConnection(CONNECTED);
    store.checkOnConnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.count('checkTokens')).toBe(2);
  });
});

describe('the store over no client is inert (R6, L1)', () => {
  it('ignores every mutator, starts no timer and stays SERVER_STATE', async () => {
    vi.useFakeTimers();
    const store = EMPTY_STORE;
    const detach = store.attach();
    const off = store.subscribe(() => {
      throw new Error('notified');
    });
    store.changed();
    store.recordJoin(Promise.resolve({} as never));
    store.resetJoinFlow();
    store.dismissLeadership();
    store.previewChanged();
    store.recordBlockList('g-1', ['p-1']);
    store.checkOnConnect();
    await expect(store.checkStoredGroups()).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    detach();
    off();
    expect(store.getState()).toBe(SERVER_STATE);
    expect(store.client).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a closed, fatal connection for invalid options', () => {
    const error = new SyncClientError('INVALID_OPTIONS', { details: { field: 'url' } });
    const store = new SyncStore(null, error);
    const state = store.getState();
    expect(state.snapshot.connection).toEqual({ status: 'closed', reason: 'fatal', error });
    expect(state.lastError).toBe(error);
    expect(store.getState()).toBe(state);
    expect(store.getServerState()).toBe(SERVER_STATE);
  });
});

describe('updateRequiredOf (AC14)', () => {
  const closed = (error: SyncClientError) => ({
    connection: { status: 'closed' as const, reason: 'fatal' as const, error },
    group: null,
  });

  it('maps the three codes, with and without details', () => {
    expect(
      updateRequiredOf(
        closed(new SyncClientError('APP_VERSION_TOO_OLD', { details: { minAppVersion: '2.0.0' } })),
        null,
      ),
    ).toEqual({ kind: 'app', minAppVersion: '2.0.0' });
    expect(updateRequiredOf(closed(new SyncClientError('APP_VERSION_TOO_OLD')), null)).toEqual({
      kind: 'app',
    });
    expect(
      updateRequiredOf(
        closed(new SyncClientError('PROTOCOL_TOO_OLD', { details: { minProtocolVersion: 3 } })),
        null,
      ),
    ).toEqual({ kind: 'protocol', minProtocolVersion: 3 });
    expect(updateRequiredOf(closed(new SyncClientError('PROTOCOL_TOO_OLD')), null)).toEqual({
      kind: 'protocol',
    });
    expect(
      updateRequiredOf(
        closed(
          new SyncClientError('SERVER_UNSUPPORTED', {
            details: {
              clientProtocolVersion: 1,
              minServerProtocolVersion: 1,
              serverProtocolVersion: 9,
              serverMinProtocolVersion: 8,
            },
          }),
        ),
        null,
      ),
    ).toEqual({
      kind: 'server_unsupported',
      serverProtocolVersion: 9,
      serverMinProtocolVersion: 8,
    });
  });

  it('falls back to the last error and ignores other codes', () => {
    expect(updateRequiredOf(IDLE_SNAPSHOT, new SyncClientError('APP_VERSION_TOO_OLD'))).toEqual({
      kind: 'app',
    });
    expect(updateRequiredOf(closed(new SyncClientError('INVALID_API_KEY')), null)).toBeNull();
    expect(updateRequiredOf(IDLE_SNAPSHOT, null)).toBeNull();
  });
});
