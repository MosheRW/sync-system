import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TokenStorage, memoryStorage } from '../src/storage.js';
import { connectedClient } from './helpers/client.js';
import { FakeWebSocket } from './helpers/fake-websocket.js';
import { fakeToken, groupIdOf } from './helpers/tokens.js';

const KEY = 'sync-system:v1:app-a@127.0.0.1:1';
const GID = groupIdOf('G');

function stored(
  storage: TokenStorage,
): Array<{ token: string; recovery?: Record<string, unknown> }> {
  const text = storage.getItem(KEY) as string | null;
  if (text === null) return [];
  return (JSON.parse(text) as { entries: Array<{ token: string }> }).entries;
}

beforeEach(() => {
  FakeWebSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('token capture (#5 AC31, AC34)', () => {
  it('stores the leader token with metadata and the initial position on create', async () => {
    const storage = memoryStorage();
    const { client, socket } = await connectedClient({ storage });
    const creating = client.createGroup({ book: 'b' }, { page: 1 });
    const token = fakeToken({ gid: GID });
    socket.receive({
      type: 'group.created',
      reqId: socket.lastMessage().reqId,
      groupId: GID,
      participantId: 'p',
      role: 'leader',
      token,
    });
    await creating;
    await vi.waitFor(() => expect(stored(storage)).toHaveLength(1));
    expect(stored(storage)[0]).toEqual({
      token,
      recovery: {
        metadata: { book: 'b' },
        hasPosition: true,
        position: { page: 1 },
        blockList: [],
      },
    });
    client.close();
  });

  it('stores a member token on join, without recovery data', async () => {
    const storage = memoryStorage();
    const { client, socket } = await connectedClient({ storage });
    const joining = client.joinGroup(GID);
    const token = fakeToken({ gid: GID, role: 'member' });
    socket.receive({
      type: 'group.joined',
      reqId: socket.lastMessage().reqId,
      groupId: GID,
      participantId: 'p',
      role: 'member',
      metadata: {},
      token,
      leaderOnline: true,
      hasPosition: false,
    });
    await joining;
    await vi.waitFor(() => expect(stored(storage)).toEqual([{ token }]));
    client.close();
  });

  it('replaces the token on token.refreshed and records positions for recovery', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const { client, socket } = await connectedClient({ storage });
    const creating = client.createGroup({});
    socket.receive({
      type: 'group.created',
      reqId: socket.lastMessage().reqId,
      groupId: GID,
      participantId: 'p',
      role: 'leader',
      token: fakeToken({ gid: GID }),
    });
    await creating;
    client.updatePosition({ page: 5 });
    const refreshed = fakeToken({ gid: GID });
    socket.receive({ type: 'token.refreshed', groupId: GID, token: refreshed });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored(storage)).toEqual([
      {
        token: refreshed,
        recovery: { metadata: {}, hasPosition: true, position: { page: 5 }, blockList: [] },
      },
    ]);
    client.close();
  });

  it('keeps tokens on close() (resume later)', async () => {
    const storage = memoryStorage();
    const { client, socket } = await connectedClient({ storage });
    const creating = client.createGroup({});
    socket.receive({
      type: 'group.created',
      reqId: socket.lastMessage().reqId,
      groupId: GID,
      participantId: 'p',
      role: 'leader',
      token: fakeToken({ gid: GID }),
    });
    await creating;
    client.close();
    await vi.waitFor(() => expect(stored(storage)).toHaveLength(1));
  });

  it('keys storage by the namespace from hello.ok and the URL host (AC33)', async () => {
    const storage = memoryStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    const getItem = vi.spyOn(storage, 'getItem');
    const { client } = await connectedClient({ storage });
    await vi.waitFor(() => expect(getItem).toHaveBeenCalledWith(KEY));
    expect(setItem).not.toHaveBeenCalled();
    client.close();
  });

  it('uses localStorage by default, looked up only after hello.ok (AC32)', async () => {
    const local = memoryStorage();
    const getter = vi.fn(() => local);
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: getter });
    try {
      const { client, socket } = await connectedClient();
      expect(getter).toHaveBeenCalledTimes(1);
      const creating = client.createGroup({});
      socket.receive({
        type: 'group.created',
        reqId: socket.lastMessage().reqId,
        groupId: GID,
        participantId: 'p',
        role: 'leader',
        token: fakeToken({ gid: GID }),
      });
      await creating;
      await vi.waitFor(() => expect(stored(local)).toHaveLength(1));
      client.close();
    } finally {
      if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('falls back to memory with a warning when localStorage throws', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('SENTINEL', 'SecurityError');
      },
    });
    const warn = vi.fn();
    try {
      const { client } = await connectedClient({ logger: { warn } });
      expect(warn).toHaveBeenCalledWith('storage_unavailable', { name: 'SecurityError' });
      client.close();
    } finally {
      if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
      else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
});
