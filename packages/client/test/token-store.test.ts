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

describe('TokenStore: marks made before any successful read (#7 L-a)', () => {
  const A = groupIdOf('A');
  const C = groupIdOf('C');
  const NOW_S = Math.floor(Date.now() / 1000);

  it('keeps a group deleted that was forgotten while storage was never readable (L-a)', async () => {
    const area = sharedArea();
    const tabA = area.tab();
    const tabB = area.tab();
    await tabB.tokens.saveToken(fakeToken({ gid: A, iat: NOW_S - 60 })); // stored by another tab
    tabA.fail.get = true;
    tabA.fail.set = true;
    await tabA.tokens.saveToken(fakeToken({ gid: A, iat: NOW_S - 30 })); // never read, never written
    await tabA.tokens.remove([A]); // forgetGroup() in tab A, not written either
    tabA.fail.get = false;
    expect(await tabA.tokens.load()).toEqual([]); // reads recover, writes still fail
    tabA.fail.set = false;
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect([...area.stored().keys()]).toEqual([C]);
    expect(tabA.tokens.find(A)).toBeUndefined();
  });

  it('keeps a token stored while storage was never readable until it is written (L-a)', async () => {
    const area = sharedArea();
    const tabA = area.tab();
    const tabB = area.tab();
    await tabB.tokens.saveToken(fakeToken({ gid: A, iat: NOW_S - 30 }));
    tabA.fail.get = true;
    tabA.fail.set = true;
    const mine = fakeToken({ gid: A, iat: NOW_S - 60 });
    await tabA.tokens.saveToken(mine);
    tabA.fail.get = false;
    expect((await tabA.tokens.findFresh(A))?.token).toBe(mine);
    tabA.fail.set = false;
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect(area.stored().get(A)).toBe(mine);
  });

  it('applies the cross-tab rules again after a successful read and write (L-a)', async () => {
    const area = sharedArea();
    const tabA = area.tab();
    const tabB = area.tab();
    tabA.fail.get = true;
    tabA.fail.set = true;
    await tabA.tokens.saveToken(fakeToken({ gid: A, iat: NOW_S - 90 }));
    tabA.fail.get = false;
    tabA.fail.set = false;
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' })); // real read + write
    tabA.fail.set = true;
    await tabA.tokens.remove([A]); // dirty, marked from a real read
    const newer = fakeToken({ gid: A, iat: NOW_S - 10 });
    await tabB.tokens.saveToken(newer);
    tabA.fail.set = false;
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect(area.stored().get(A)).toBe(newer);
  });
});

describe('TokenStore: failed forgetAllGroups (#7 AC17, R5)', () => {
  const A = groupIdOf('A');
  const C = groupIdOf('C');
  const X = groupIdOf('X');

  it('keeps groups deleted that were stored but not loaded in this tab (AC17)', async () => {
    const area = sharedArea();
    const tabA = area.tab();
    const tabB = area.tab();
    await tabA.tokens.saveToken(fakeToken({ gid: A }));
    // Stored by another tab after tab A's last read: never loaded in tab A.
    await tabB.tokens.saveToken(fakeToken({ gid: X, role: 'member' }));
    expect(tabA.tokens.find(X)).toBeUndefined();

    tabA.fail.remove = true;
    await tabA.tokens.removeAll();
    expect(tabA.tokens.entries()).toEqual([]);
    expect(await tabA.tokens.load()).toEqual([]);

    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect([...area.stored().keys()]).toEqual([C]);
  });

  it('lets a newer token another tab stores afterwards win (AC17, rule 3)', async () => {
    const area = sharedArea();
    const tabA = area.tab();
    const tabB = area.tab();
    await tabA.tokens.saveToken(fakeToken({ gid: A, iat: Math.floor(Date.now() / 1000) - 60 }));
    tabA.fail.remove = true;
    await tabA.tokens.removeAll();
    const newer = fakeToken({ gid: A });
    await tabB.tokens.saveToken(newer);
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect(area.stored().get(A)).toBe(newer);
  });

  it('failed remove, failed read, then a successful read and write: the group stays deleted (R5)', async () => {
    const area = sharedArea();
    const tabA = area.tab();
    await tabA.tokens.saveToken(fakeToken({ gid: A }));
    tabA.fail.remove = true;
    await tabA.tokens.removeAll();
    tabA.fail.get = true;
    expect(await tabA.tokens.load()).toEqual([]);
    tabA.fail.get = false;
    expect(await tabA.tokens.load()).toEqual([]);
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect([...area.stored().keys()]).toEqual([C]);
  });

  it('marks the groups it knows when the read after the failed remove fails too (R5)', async () => {
    const area = sharedArea();
    const tabA = area.tab();
    await tabA.tokens.saveToken(fakeToken({ gid: A }));
    tabA.fail.remove = true;
    tabA.fail.get = true;
    await tabA.tokens.removeAll();
    expect(await tabA.tokens.load()).toEqual([]);
    tabA.fail.get = false;
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect([...area.stored().keys()]).toEqual([C]);
  });

  it('drops groups other tabs stored before it when this tab never read storage (L-c)', async () => {
    const area = sharedArea();
    const tabA = area.tab();
    const tabB = area.tab();
    const NOW_S = Math.floor(Date.now() / 1000);
    await tabB.tokens.saveToken(fakeToken({ gid: X, iat: NOW_S - 60, role: 'member' }));
    tabA.fail.get = true;
    tabA.fail.remove = true;
    await tabA.tokens.removeAll(); // delete and fallback read both fail
    expect(await tabA.tokens.load()).toEqual([]); // a failed read changes nothing (R5)
    tabA.fail.get = false;
    tabA.fail.remove = false;
    expect(await tabA.tokens.load()).toEqual([]);
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect([...area.stored().keys()]).toEqual([C]);
    expect(await tabA.tokens.load()).toHaveLength(1);
  });

  it('keeps a strictly newer token another tab stores after that forget (L-c)', async () => {
    const area = sharedArea();
    const tabA = area.tab();
    const tabB = area.tab();
    const NOW_S = Math.floor(Date.now() / 1000);
    await tabB.tokens.saveToken(fakeToken({ gid: X, iat: NOW_S - 60, role: 'member' }));
    tabA.fail.get = true;
    tabA.fail.remove = true;
    await tabA.tokens.removeAll();
    const newer = fakeToken({ gid: X, iat: NOW_S + 5, role: 'member' });
    await tabB.tokens.saveToken(newer);
    tabA.fail.get = false;
    tabA.fail.remove = false;
    expect((await tabA.tokens.findFresh(X))?.token).toBe(newer);
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect(area.stored().get(X)).toBe(newer);
    expect(area.stored().has(C)).toBe(true);
  });
});

describe('TokenStore: forget cut-off under clock changes (#9)', () => {
  const C = groupIdOf('C');
  const X = groupIdOf('X');
  const Y = groupIdOf('Y');
  const T = 10_000_000_000;
  const T_S = Math.floor(T / 1000);
  const TEN_MIN = 10 * 60_000;

  /** Tab A's delete and fallback read both fail, then storage recovers. */
  async function doublyFailedForget(tab: {
    tokens: TokenStore;
    fail: { get: boolean; remove: boolean };
  }) {
    tab.fail.get = true;
    tab.fail.remove = true;
    await tab.tokens.removeAll();
    tab.fail.get = false;
    tab.fail.remove = false;
  }

  it('never lowers the cut-off when the clock steps back between two failed forgets (AC1)', async () => {
    vi.useFakeTimers({ now: T });
    const area = sharedArea();
    const tabA = area.tab();
    const tabB = area.tab();
    await tabB.tokens.saveToken(fakeToken({ gid: X, iat: T_S - 30, role: 'member' }));
    await doublyFailedForget(tabA);
    vi.setSystemTime(T - TEN_MIN);
    await doublyFailedForget(tabA);
    expect(await tabA.tokens.load()).toEqual([]);
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect([...area.stored().keys()]).toEqual([C]);
  });

  it('raises the cut-off when the clock moves forward between two failed forgets (AC1)', async () => {
    vi.useFakeTimers({ now: T });
    const area = sharedArea();
    const tabA = area.tab();
    const tabB = area.tab();
    await doublyFailedForget(tabA);
    vi.setSystemTime(T + TEN_MIN);
    await tabB.tokens.saveToken(fakeToken({ gid: X, iat: T_S + 300, role: 'member' }));
    await doublyFailedForget(tabA);
    const later = fakeToken({ gid: Y, iat: T_S + 3600, role: 'member' });
    await tabB.tokens.saveToken(later);
    expect((await tabA.tokens.load()).map((entry) => entry.token)).toEqual([later]);
    await tabA.tokens.saveToken(fakeToken({ gid: C, role: 'member' }));
    expect([...area.stored().keys()].sort()).toEqual([C, Y].sort());
  });
});

describe('codes blob in recovery data (#10 AC32, R2, N1)', () => {
  const GID = groupIdOf('A');
  const blob = (n: number) => `eyJuIjo${n}fQ.${'B'.repeat(43)}`;

  it('stores the blob with its generation and drops a blob without a valid one on load', async () => {
    const storage = memoryStorage();
    const tokens = store(storage);
    const token = fakeToken({ gid: GID });
    await tokens.saveToken(token, { ...RECOVERY, joinCodes: blob(1), joinCodesGeneration: 10 });
    expect(doc(storage).entries[0]).toEqual({
      token,
      recovery: { ...RECOVERY, joinCodes: blob(1), joinCodesGeneration: 10 },
    });
    for (const bad of [
      { joinCodes: blob(1) },
      { joinCodes: blob(1), joinCodesGeneration: -1 },
      { joinCodes: blob(1), joinCodesGeneration: 1.5 },
      { joinCodes: 'not a blob', joinCodesGeneration: 1 },
      { joinCodes: 'x'.repeat(600), joinCodesGeneration: 1 },
    ]) {
      await storage.setItem(
        KEY,
        JSON.stringify({ v: 1, entries: [{ token, recovery: { ...RECOVERY, ...bad } }] }),
      );
      const loaded = await store(storage).findFresh(GID);
      expect(loaded?.recovery).toEqual(RECOVERY);
    }
  });

  it('keeps the higher generation when merging copies, in either order (R2)', async () => {
    const storage = memoryStorage();
    const tab1 = store(storage);
    const tab2 = store(storage);
    await tab1.saveToken(fakeToken({ gid: GID }), {
      ...RECOVERY,
      joinCodes: blob(1),
      joinCodesGeneration: 1,
    });
    await tab2.load();
    // Tab 1 hears of a rotation; tab 2 then writes its older copy.
    await tab1.setJoinCodes(GID, blob(2), 2, { fromServer: true });
    await tab2.setJoinCodes(GID, blob(1), 1, { fromServer: false });
    expect((await tab2.findFresh(GID))?.recovery?.joinCodes).toBe(blob(2));
    expect((await store(storage).findFresh(GID))?.recovery?.joinCodesGeneration).toBe(2);
    // The other order: a newer copy merged in replaces an older one.
    await tab2.setJoinCodes(GID, blob(3), 3, { fromServer: false });
    expect((await tab1.findFresh(GID))?.recovery?.joinCodesGeneration).toBe(3);
  });

  it('keeps the higher generation when a dirty in-memory copy meets storage (R2)', async () => {
    const backing = memoryStorage();
    let failWrites = false;
    const flaky: TokenStorage = {
      getItem: (key) => backing.getItem(key),
      setItem: (key, value) =>
        failWrites ? Promise.reject(new Error('quota')) : backing.setItem(key, value),
      removeItem: (key) => backing.removeItem(key),
    };
    const tab1 = store(flaky);
    const tab2 = store(backing);
    const token = fakeToken({ gid: GID });
    await tab1.saveToken(token, { ...RECOVERY, joinCodes: blob(1), joinCodesGeneration: 1 });
    failWrites = true;
    await tab1.updateRecovery(GID, { hasPosition: true, position: 9 });
    await tab2.setJoinCodes(GID, blob(5), 5, { fromServer: true });
    failWrites = false;
    const merged = await tab1.findFresh(GID);
    expect(merged?.recovery).toMatchObject({ position: 9, joinCodesGeneration: 5 });
  });

  it('always stores a blob from a direct server reply, even with a lower generation (N1)', async () => {
    const storage = memoryStorage();
    const tokens = store(storage);
    await tokens.saveToken(fakeToken({ gid: GID }), {
      ...RECOVERY,
      joinCodes: blob(9),
      joinCodesGeneration: 9,
    });
    await tokens.setJoinCodes(GID, blob(4), 4, { fromServer: true });
    expect((await store(storage).findFresh(GID))?.recovery).toMatchObject({
      joinCodes: blob(4),
      joinCodesGeneration: 4,
    });
    // A full recovery from a server reply (group.resumed) also replaces it.
    await tokens.saveToken(fakeToken({ gid: GID }), {
      ...RECOVERY,
      joinCodes: blob(2),
      joinCodesGeneration: 2,
    });
    expect((await store(storage).findFresh(GID))?.recovery?.joinCodesGeneration).toBe(2);
  });

  it('deletes the blob with the recovery data (AC40)', async () => {
    const storage = memoryStorage();
    const tokens = store(storage);
    await tokens.saveToken(fakeToken({ gid: GID }), {
      ...RECOVERY,
      joinCodes: blob(1),
      joinCodesGeneration: 1,
    });
    await tokens.remove([GID]);
    expect(storage.getItem(KEY)).not.toContain('joinCodes');
  });
});
