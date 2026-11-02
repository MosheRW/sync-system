import { afterEach, describe, expect, it, vi } from 'vitest';
import { type TokenStorage, memoryStorage } from '../src/storage.js';
import {
  MAX_STORED_TOKENS,
  POSITION_SAVE_INTERVAL_MS,
  type Recovery,
  TokenStore,
  storageKey,
} from '../src/token-store.js';
import { fakeToken, groupIdOf } from './helpers/tokens.js';

const KEY = 'sync-system:v1:app-a@sync.example.com';
const RECOVERY: Recovery = { metadata: { book: 1 }, hasPosition: true, position: 3, blockList: [] };

function store(storage: TokenStorage = memoryStorage(), log = vi.fn(), maxSessionMinutes = 180) {
  return new TokenStore(storage, 'app-a', 'sync.example.com', log, maxSessionMinutes);
}

function doc(storage: TokenStorage): { v: number; entries: Array<Record<string, unknown>> } {
  return JSON.parse(storage.getItem(KEY) as string) as {
    v: number;
    entries: Array<Record<string, unknown>>;
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('storageKey (#5 AC33, Q12)', () => {
  it('is per namespace and host', () => {
    expect(storageKey('reading-app', 'sync.example.com')).toBe(
      'sync-system:v1:reading-app@sync.example.com',
    );
    expect(storageKey('a', 'localhost:8080')).toBe('sync-system:v1:a@localhost:8080');
  });
});

describe('TokenStore: saving (#5 AC31, AC33, AC34)', () => {
  it('stores a versioned document with the token and leader recovery data only', async () => {
    const storage = memoryStorage();
    const tokens = store(storage);
    const leader = fakeToken({ gid: groupIdOf('A') });
    const member = fakeToken({ gid: groupIdOf('B'), role: 'member' });
    await tokens.saveToken(leader, RECOVERY);
    await tokens.saveToken(member, RECOVERY);
    expect(doc(storage)).toEqual({
      v: 1,
      entries: [{ token: leader, recovery: RECOVERY }, { token: member }],
    });
    expect(tokens.find(groupIdOf('A'))?.claims.role).toBe('leader');
  });

  it('replaces the previous token of the same group and keeps leader recovery data', async () => {
    const storage = memoryStorage();
    const tokens = store(storage);
    await tokens.saveToken(fakeToken({ gid: groupIdOf('A') }), RECOVERY);
    const refreshed = fakeToken({ gid: groupIdOf('A') });
    await tokens.saveToken(refreshed);
    expect(doc(storage).entries).toEqual([{ token: refreshed, recovery: RECOVERY }]);
  });

  it('ignores undecodable tokens and other apps’ tokens', async () => {
    const storage = memoryStorage();
    const tokens = store(storage);
    await tokens.saveToken('not.a.token');
    await tokens.saveToken(fakeToken({ aud: 'app-b' }));
    expect(storage.getItem(KEY)).toBeNull();
  });

  it('updates recovery data and removes groups', async () => {
    const storage = memoryStorage();
    const tokens = store(storage);
    await tokens.saveToken(fakeToken({ gid: groupIdOf('A') }), RECOVERY);
    await tokens.saveToken(fakeToken({ gid: groupIdOf('B') }), RECOVERY);
    await tokens.updateRecovery(groupIdOf('A'), {
      blockList: ['0b6a3f5e-8c1d-4e2f-9a7b-1c2d3e4f5a6b'],
    });
    expect(tokens.find(groupIdOf('A'))?.recovery?.blockList).toHaveLength(1);
    await tokens.remove([groupIdOf('A')]);
    expect(doc(storage).entries).toHaveLength(1);
    await tokens.removeAll();
    expect(storage.getItem(KEY)).toBeNull();
    expect(tokens.entries()).toEqual([]);
  });

  it('coalesces position saves to one write per second, flushing on demand', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    const tokens = store(storage);
    await tokens.saveToken(fakeToken({ gid: groupIdOf('A') }), RECOVERY);
    setItem.mockClear();
    for (let i = 0; i < 10; i++) tokens.savePosition(groupIdOf('A'), i);
    expect(tokens.find(groupIdOf('A'))?.recovery?.position).toBe(9);
    expect(setItem).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POSITION_SAVE_INTERVAL_MS);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(doc(storage).entries[0]?.recovery).toMatchObject({ position: 9 });
    tokens.savePosition(groupIdOf('A'), 10);
    await tokens.flush();
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(doc(storage).entries[0]?.recovery).toMatchObject({ position: 10 });
  });

  it('survives a new store instance over the same storage (page reload)', async () => {
    const storage = memoryStorage();
    await store(storage).saveToken(fakeToken({ gid: groupIdOf('A') }), RECOVERY);
    const reloaded = store(storage);
    expect(await reloaded.load()).toHaveLength(1);
    expect(reloaded.find(groupIdOf('A'))?.recovery).toEqual(RECOVERY);
  });
});

describe('TokenStore: pruning (#5 AC33, M6)', () => {
  it('drops tokens past their max session time on load, without a server', async () => {
    vi.useFakeTimers({ now: 10_000_000_000 });
    const storage = memoryStorage();
    await store(storage).saveToken(fakeToken({ gid: groupIdOf('A') }), RECOVERY);
    vi.setSystemTime(10_000_000_000 + 180 * 60_000);
    expect(await store(storage).load()).toEqual([]);
  });

  it('drops expired tokens by exp', async () => {
    const storage = memoryStorage();
    const tokens = store(storage, vi.fn(), 10_000_000);
    const past = Math.floor(Date.now() / 1000) - 400 * 86_400;
    await tokens.saveToken(
      fakeToken({ iat: past, exp: past + 10, gct: past * 1000, lat: past * 1000 }),
    );
    expect(tokens.entries()).toEqual([]);
  });

  it('keeps at most 20: expired first, then the oldest by last activity', async () => {
    const storage = memoryStorage();
    const tokens = store(storage);
    const base = Date.now() - 60_000;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUV';
    for (let i = 0; i < 21; i++) {
      await tokens.saveToken(
        fakeToken({ gid: groupIdOf(chars[i]!), lat: base + i * 1000, gct: base }),
      );
    }
    const kept = tokens.entries().map((entry) => entry.claims.gid);
    expect(kept).toHaveLength(MAX_STORED_TOKENS);
    expect(kept).not.toContain(groupIdOf('A'));
    expect(kept).toContain(groupIdOf('U'));
  });
});

describe('TokenStore: untrusted stored data (#5 AC33, L8)', () => {
  const cases: Array<[string, string]> = [
    ['unparsable JSON', '{not json'],
    ['a wrong version', JSON.stringify({ v: 2, entries: [] })],
    ['entries not an array', JSON.stringify({ v: 1, entries: { a: 1 } })],
    ['a non-object', JSON.stringify([1, 2])],
    ['an over-long document', JSON.stringify({ v: 1, entries: [], pad: 'x'.repeat(262_144) })],
  ];
  for (const [label, text] of cases) {
    it(`discards ${label} without throwing`, async () => {
      const storage = memoryStorage();
      void storage.setItem(KEY, text);
      expect(await store(storage).load()).toEqual([]);
    });
  }

  it('drops bad entries one by one and keeps the good ones', async () => {
    const storage = memoryStorage();
    const good = fakeToken({ gid: groupIdOf('A') });
    const older = fakeToken({ gid: groupIdOf('B'), iat: Math.floor(Date.now() / 1000) - 10 });
    const newer = fakeToken({ gid: groupIdOf('B') });
    void storage.setItem(
      KEY,
      JSON.stringify({
        v: 1,
        entries: [
          { token: good, recovery: RECOVERY },
          { token: 'garbage' },
          { token: 'x'.repeat(2049) },
          { token: 42 },
          null,
          { token: older },
          { token: newer },
          {
            token: fakeToken({ gid: groupIdOf('C') }),
            recovery: { metadata: [], hasPosition: false, blockList: [] },
          },
          {
            token: fakeToken({ gid: groupIdOf('D') }),
            recovery: { ...RECOVERY, blockList: ['bad'] },
          },
          {
            token: fakeToken({ gid: groupIdOf('E') }),
            recovery: { metadata: {}, hasPosition: true, blockList: [] },
          },
          { token: fakeToken({ aud: 'app-b', gid: groupIdOf('F') }) },
        ],
      }),
    );
    const entries = await store(storage).load();
    expect(entries.map((e) => e.token)).toEqual([good, newer]);
  });

  it('is not fooled by __proto__ content', async () => {
    const storage = memoryStorage();
    const token = fakeToken({ gid: groupIdOf('A') });
    void storage.setItem(
      KEY,
      `{"v":1,"__proto__":{"polluted":true},"entries":[{"token":"${token}","__proto__":{"x":1}}]}`,
    );
    const entries = await store(storage).load();
    expect(entries).toHaveLength(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('logs storage failures by name, keeps the memory copy, and never rejects', async () => {
    const log = vi.fn();
    const failing: TokenStorage = {
      getItem: () => {
        throw new Error('SENTINEL get');
      },
      setItem: () => Promise.reject(new DOMException('SENTINEL quota', 'QuotaExceededError')),
      removeItem: () => {
        throw new TypeError('SENTINEL remove');
      },
    };
    const tokens = store(failing, log);
    await tokens.saveToken(fakeToken({ gid: groupIdOf('A') }));
    expect(tokens.entries()).toHaveLength(1);
    await tokens.removeAll();
    expect(log).toHaveBeenCalledWith('warn', 'storage_error', { op: 'get', name: 'Error' });
    expect(log).toHaveBeenCalledWith('warn', 'storage_error', {
      op: 'set',
      name: 'QuotaExceededError',
    });
    expect(log).toHaveBeenCalledWith('warn', 'storage_error', { op: 'remove', name: 'TypeError' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('SENTINEL');
  });

  describe('readable storage whose writes fail (quota full)', () => {
    function quotaStorage() {
      const inner = memoryStorage();
      const state = { full: false };
      const storage: TokenStorage = {
        getItem: (key) => inner.getItem(key),
        setItem: (key, value) => {
          if (state.full) throw new DOMException('quota', 'QuotaExceededError');
          void inner.setItem(key, value);
        },
        removeItem: (key) => inner.removeItem(key),
      };
      return { storage, state };
    }

    it('keeps an unsaved token over the stored document on the next load', async () => {
      const { storage, state } = quotaStorage();
      const tokens = store(storage);
      const old = fakeToken({ gid: groupIdOf('A') });
      await tokens.saveToken(old, RECOVERY);
      state.full = true;
      const fresh = fakeToken({ gid: groupIdOf('A') });
      const member = fakeToken({ gid: groupIdOf('B'), role: 'member' });
      await tokens.saveToken(fresh);
      await tokens.saveToken(member);
      expect((await tokens.findFresh(groupIdOf('A')))?.token).toBe(fresh);
      expect((await tokens.findFresh(groupIdOf('A')))?.recovery).toEqual(RECOVERY);
      expect((await tokens.findFresh(groupIdOf('B')))?.token).toBe(member);
    });

    it('keeps an unsaved removal and still merges other groups from storage', async () => {
      const { storage, state } = quotaStorage();
      const tokens = store(storage);
      await tokens.saveToken(fakeToken({ gid: groupIdOf('A') }));
      state.full = true;
      await tokens.remove([groupIdOf('A')]);
      const otherTab = fakeToken({ gid: groupIdOf('C'), role: 'member' });
      // Another tab, whose write goes through, stores a token for group C.
      state.full = false;
      await store(storage).saveToken(otherTab);
      state.full = true;
      const ids = (await tokens.load()).map((e) => e.claims.gid);
      expect(ids).toEqual([groupIdOf('C')]);
    });

    it('lets storage win again once a write succeeds', async () => {
      const { storage, state } = quotaStorage();
      const tokens = store(storage);
      state.full = true;
      const a = fakeToken({ gid: groupIdOf('A') });
      await tokens.saveToken(a);
      state.full = false;
      await tokens.saveToken(fakeToken({ gid: groupIdOf('B') }));
      expect(doc(storage).entries.map((e) => e.token)).toContain(a);
      void storage.setItem(KEY, JSON.stringify({ v: 1, entries: [] }));
      expect(await tokens.load()).toEqual([]);
    });
  });

  it('works with an async store', async () => {
    const inner = memoryStorage();
    const asyncStorage: TokenStorage = {
      getItem: async (key) => inner.getItem(key),
      setItem: async (key, value) => inner.setItem(key, value),
      removeItem: async (key) => inner.removeItem(key),
    };
    const tokens = store(asyncStorage);
    await tokens.saveToken(fakeToken({ gid: groupIdOf('A') }), RECOVERY);
    expect(await store(asyncStorage).load()).toHaveLength(1);
  });

  it('merges with what another tab wrote meanwhile (read-merge-write)', async () => {
    const storage = memoryStorage();
    const tabA = store(storage);
    const tabB = store(storage);
    await tabA.saveToken(fakeToken({ gid: groupIdOf('A') }));
    await tabB.saveToken(fakeToken({ gid: groupIdOf('B') }));
    expect(doc(storage).entries).toHaveLength(2);
  });
});

/** Two or more tabs over one storage area, each with its own injectable failures (#7 L5). */
function sharedArea() {
  const inner = memoryStorage();
  const tab = () => {
    const fail = { get: false, set: false, remove: false };
    const storage: TokenStorage = {
      getItem: (key) => {
        if (fail.get) throw new Error('get failed');
        return inner.getItem(key);
      },
      setItem: (key, value) => {
        if (fail.set) throw new DOMException('quota', 'QuotaExceededError');
        void inner.setItem(key, value);
      },
      removeItem: (key) => {
        if (fail.remove) throw new Error('remove failed');
        void inner.removeItem(key);
      },
    };
    return { tokens: store(storage), fail };
  };
  /** Group ID -> stored token, as the shared document holds it now. */
  const stored = (): Map<string, string> => {
    const text = inner.getItem(KEY) as string | null;
    if (text === null) return new Map();
    return new Map(
      doc(inner).entries.map((e) => {
        const token = e.token as string;
        const payload = JSON.parse(
          Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'),
        ) as { gid: string };
        return [payload.gid, token];
      }),
    );
  };
  return { inner, tab, stored };
}

describe('TokenStore: cross-tab changes win over dirty groups (#7 L5)', () => {
  const A = groupIdOf('A');
  const C = groupIdOf('C');
  const N = groupIdOf('N');
  const X = groupIdOf('X');
  // Token times in seconds, recent enough not to be pruned as expired.
  const NOW_S = Math.floor(Date.now() / 1000);
  const T100 = NOW_S - 300;
  const T200 = NOW_S - 200;
  const T300 = NOW_S - 100;

  it('does not write back a group another tab forgot (AC14, AC15)', async () => {
    const area = sharedArea();
    const tabA = area.tab();
    const tabB = area.tab();
    await tabA.tokens.saveToken(fakeToken({ gid: A, iat: T100 }));
    tabA.fail.set = true;
    await tabA.tokens.saveToken(fakeToken({ gid: A, iat: T200 })); // dirty in tab A
    await tabB.tokens.remove([A]);
    tabA.fail.set = false;
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect([...area.stored().keys()]).toEqual([C]);
    expect(tabA.tokens.find(A)).toBeUndefined();
  });

  it('does not write back groups after another tab ran forgetAllGroups (AC15)', async () => {
    const area = sharedArea();
    const tabA = area.tab();
    const tabB = area.tab();
    await tabA.tokens.saveToken(fakeToken({ gid: A, iat: T100 }));
    tabA.fail.set = true;
    await tabA.tokens.saveToken(fakeToken({ gid: A, iat: T200 }));
    await tabB.tokens.removeAll();
    tabA.fail.set = false;
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect([...area.stored().keys()]).toEqual([C]);
  });

  it('keeps a newer token another tab stored over an older dirty copy (AC16)', async () => {
    const area = sharedArea();
    const tabA = area.tab();
    const tabB = area.tab();
    await tabA.tokens.saveToken(fakeToken({ gid: A, iat: T100 }));
    tabA.fail.set = true;
    await tabA.tokens.saveToken(fakeToken({ gid: A, iat: T200 }));
    const newer = fakeToken({ gid: A, iat: T300 });
    await tabB.tokens.saveToken(newer);
    tabA.fail.set = false;
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect(area.stored().get(A)).toBe(newer);
    expect(tabA.tokens.find(A)?.token).toBe(newer);
  });

  it('keeps the dirty copy when the other tab’s token is not newer (rule 4)', async () => {
    const area = sharedArea();
    const tabA = area.tab();
    const tabB = area.tab();
    await tabA.tokens.saveToken(fakeToken({ gid: A, iat: T100 }));
    tabA.fail.set = true;
    const mine = fakeToken({ gid: A, iat: T300 });
    await tabA.tokens.saveToken(mine);
    await tabB.tokens.saveToken(fakeToken({ gid: A, iat: T200 }));
    tabA.fail.set = false;
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect(area.stored().get(A)).toBe(mine);
  });

  it('keeps the dirty copy while storage is unchanged (today’s behaviour)', async () => {
    const area = sharedArea();
    const tabA = area.tab();
    await tabA.tokens.saveToken(fakeToken({ gid: A, iat: T100 }));
    tabA.fail.set = true;
    const mine = fakeToken({ gid: A, iat: T200 });
    await tabA.tokens.saveToken(mine);
    expect((await tabA.tokens.findFresh(A))?.token).toBe(mine);
    tabA.fail.set = false;
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect(area.stored().get(A)).toBe(mine);
  });

  it('never drops a mark on a failed read: a forgotten group stays deleted (R5)', async () => {
    const area = sharedArea();
    const tabA = area.tab();
    await tabA.tokens.saveToken(fakeToken({ gid: A }));
    tabA.fail.set = true;
    await tabA.tokens.remove([A]); // the delete is not written
    tabA.fail.get = true;
    await tabA.tokens.load(); // the read fails too
    tabA.fail.get = false;
    tabA.fail.set = false;
    expect(await tabA.tokens.load()).toEqual([]);
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect([...area.stored().keys()]).toEqual([C]);
  });

  it('does not write back a new group after another tab removed the whole key (L-4)', async () => {
    const area = sharedArea();
    const tabA = area.tab();
    const tabB = area.tab();
    await tabB.tokens.saveToken(fakeToken({ gid: X })); // the key exists
    tabA.fail.set = true;
    await tabA.tokens.saveToken(fakeToken({ gid: N })); // first store of N fails
    await tabB.tokens.removeAll();
    tabA.fail.set = false;
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect([...area.stored().keys()]).toEqual([C]);
  });

  it('still writes back a group whose very first write failed (documented residual case)', async () => {
    const area = sharedArea();
    const tabA = area.tab();
    const tabB = area.tab();
    tabA.fail.set = true;
    const first = fakeToken({ gid: N });
    await tabA.tokens.saveToken(first); // no key yet
    await tabB.tokens.saveToken(fakeToken({ gid: X }));
    await tabB.tokens.removeAll();
    tabA.fail.set = false;
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect(area.stored().get(N)).toBe(first);
  });
});
