import { describe, expect, it } from 'vitest';
import {
  createPageStore,
  createPointerStore,
  groupPointerKey,
  pageKey,
  safeSessionStorage,
} from '../src/group/session-store.js';
import { MemoryStorage, THROWING_STORAGE } from './helpers/storage.js';

const GROUP = 'A'.repeat(43);
const FP = 'a'.repeat(64);
const HOST = 'sync.example.org';

describe('safeSessionStorage (ADR 0009, R5)', () => {
  it('wraps a working storage', () => {
    const backing = new MemoryStorage();
    const safe = safeSessionStorage(() => backing)!;
    safe.setItem('k', 'v');
    expect(backing.getItem('k')).toBe('v');
    expect(safe.getItem('k')).toBe('v');
    safe.removeItem('k');
    expect(backing.keys()).toEqual([]);
  });

  it('is null when storage is missing or throws on access', () => {
    expect(safeSessionStorage(() => null)).toBeNull();
    expect(
      safeSessionStorage(() => {
        throw new DOMException('denied', 'SecurityError');
      }),
    ).toBeNull();
    expect(safeSessionStorage(() => THROWING_STORAGE)).toBeNull();
  });

  it('swallows failures after a successful probe (quota, revoked)', () => {
    let broken = false;
    const flaky = {
      getItem: (key: string) => {
        if (broken) throw new Error('x');
        return key === 'reader:v1:probe' ? null : 'v';
      },
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('x');
      },
    };
    const safe = safeSessionStorage(() => flaky)!;
    expect(() => safe.setItem('k', 'v')).not.toThrow();
    expect(() => safe.removeItem('k')).not.toThrow();
    broken = true;
    expect(safe.getItem('k')).toBeNull();
  });

  it('uses the real sessionStorage, never localStorage', () => {
    const safe = safeSessionStorage()!;
    safe.setItem('reader:test', '1');
    expect(sessionStorage.getItem('reader:test')).toBe('1');
    expect(localStorage.length).toBe(0);
    safe.removeItem('reader:test');
  });
});

describe('group pointer codec (R5, L8)', () => {
  it('writes, reads, updates and forgets the pointer under the sync host key', () => {
    const backing = new MemoryStorage();
    const pointers = createPointerStore(backing, HOST);
    pointers.write({ groupId: GROUP, mode: 'following', ack: null, qrShown: false });
    expect(backing.keys()).toEqual([groupPointerKey(HOST)]);
    expect(groupPointerKey(HOST)).toBe('reader:v1:group@sync.example.org');
    expect(JSON.parse(backing.getItem(groupPointerKey(HOST))!)).toEqual({
      v: 1,
      groupId: GROUP,
      mode: 'following',
      ack: null,
      qrShown: false,
    });
    pointers.update({ mode: 'browsing', ack: FP });
    expect(pointers.read()).toEqual({ groupId: GROUP, mode: 'browsing', ack: FP, qrShown: false });
    pointers.forget();
    expect(pointers.read()).toBeNull();
    expect(backing.keys()).toEqual([]);
  });

  it('keeps another sync server apart', () => {
    const backing = new MemoryStorage();
    createPointerStore(backing, HOST).write({
      groupId: GROUP,
      mode: 'following',
      ack: null,
      qrShown: false,
    });
    expect(createPointerStore(backing, 'other.example').read()).toBeNull();
  });

  it('does not write an invalid pointer', () => {
    const backing = new MemoryStorage();
    createPointerStore(backing, HOST).write({
      groupId: 'short',
      mode: 'following',
      ack: null,
      qrShown: false,
    });
    expect(backing.keys()).toEqual([]);
  });

  it.each([
    ['not JSON', '{'],
    [
      'a wrong version',
      JSON.stringify({ v: 2, groupId: GROUP, mode: 'following', ack: null, qrShown: false }),
    ],
    [
      'a short group ID',
      JSON.stringify({ v: 1, groupId: 'g-1', mode: 'following', ack: null, qrShown: false }),
    ],
    [
      'a long group ID',
      JSON.stringify({
        v: 1,
        groupId: 'A'.repeat(256),
        mode: 'following',
        ack: null,
        qrShown: false,
      }),
    ],
    [
      'a bad mode',
      JSON.stringify({ v: 1, groupId: GROUP, mode: 'leading', ack: null, qrShown: false }),
    ],
    [
      'a bad ack',
      JSON.stringify({ v: 1, groupId: GROUP, mode: 'following', ack: 'ABC', qrShown: false }),
    ],
    [
      'an extra key',
      JSON.stringify({
        v: 1,
        groupId: GROUP,
        mode: 'following',
        ack: null,
        qrShown: false,
        token: 'x',
      }),
    ],
    ['an array', '[]'],
  ])('deletes %s on read', (_name, raw) => {
    const backing = new MemoryStorage();
    backing.setItem(groupPointerKey(HOST), raw);
    expect(createPointerStore(backing, HOST).read()).toBeNull();
    expect(backing.keys()).toEqual([]);
  });

  it('stores nothing without storage', () => {
    const pointers = createPointerStore(null, HOST);
    pointers.write({ groupId: GROUP, mode: 'following', ack: null, qrShown: false });
    expect(pointers.read()).toBeNull();
  });
});

describe('page codec (AC36, Decision Q3)', () => {
  it('keeps one page per content ID and fingerprint', () => {
    const backing = new MemoryStorage();
    const pages = createPageStore(backing);
    pages.write('acme/a', FP, 3);
    pages.write('acme/b', FP, 1);
    expect(backing.getItem(pageKey('acme/a', FP))).toBe('{"v":1,"pageIndex":3}');
    expect(pages.read('acme/a', FP, 10)).toBe(3);
    expect(pages.read('acme/b', FP, 10)).toBe(1);
    expect(pages.read('acme/a', 'b'.repeat(64), 10)).toBeNull();
  });

  it('drops a page outside the book and invalid values', () => {
    const backing = new MemoryStorage();
    const pages = createPageStore(backing);
    pages.write('acme/a', FP, 5);
    expect(pages.read('acme/a', FP, 5)).toBeNull();
    expect(backing.keys()).toEqual([]);
    for (const raw of [
      '{"v":1,"pageIndex":-1}',
      '{"v":1,"pageIndex":1.5}',
      '{"pageIndex":1}',
      'x',
    ]) {
      backing.setItem(pageKey('acme/a', FP), raw);
      expect(pages.read('acme/a', FP, 10), raw).toBeNull();
      expect(backing.keys()).toEqual([]);
    }
  });

  it('never writes a bad index', () => {
    const backing = new MemoryStorage();
    const pages = createPageStore(backing);
    pages.write('acme/a', FP, -1);
    pages.write('acme/a', FP, 1.5);
    expect(backing.keys()).toEqual([]);
  });
});
