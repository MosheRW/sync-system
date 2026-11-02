import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTokenStorage, memoryStorage, resolveStorage } from '../src/storage.js';

const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

function defineLocalStorage(get: () => unknown): void {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get });
}

describe('memoryStorage', () => {
  it('stores, reads and removes strings', () => {
    const storage = memoryStorage();
    expect(storage.getItem('k')).toBeNull();
    void storage.setItem('k', 'v');
    expect(storage.getItem('k')).toBe('v');
    void storage.removeItem('k');
    expect(storage.getItem('k')).toBeNull();
  });
});

describe('isTokenStorage', () => {
  it('needs the three methods', () => {
    expect(isTokenStorage(memoryStorage())).toBe(true);
    expect(isTokenStorage({ getItem() {}, setItem() {} })).toBe(false);
    expect(isTokenStorage('local')).toBe(false);
    expect(isTokenStorage(null)).toBe(false);
  });
});

describe('resolveStorage (#5 AC32)', () => {
  it('uses localStorage when it is there', () => {
    const local = memoryStorage();
    defineLocalStorage(() => local);
    const log = vi.fn();
    expect(resolveStorage('local', log)).toBe(local);
    expect(log).not.toHaveBeenCalled();
  });

  it('falls back to memory with a warning naming the error only when the getter throws', () => {
    defineLocalStorage(() => {
      throw new DOMException('SENTINEL access denied', 'SecurityError');
    });
    const log = vi.fn();
    const storage = resolveStorage('local', log);
    expect(isTokenStorage(storage)).toBe(true);
    expect(log).toHaveBeenCalledWith('warn', 'storage_unavailable', { name: 'SecurityError' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('SENTINEL');
  });

  it('falls back to memory when there is no localStorage', () => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    const log = vi.fn();
    expect(isTokenStorage(resolveStorage('local', log))).toBe(true);
    expect(log).toHaveBeenCalledWith('warn', 'storage_unavailable', { name: 'missing' });
  });

  it('returns memory or the custom store as given', () => {
    const custom = memoryStorage();
    const getter = vi.fn(() => memoryStorage());
    defineLocalStorage(getter);
    expect(resolveStorage(custom, vi.fn())).toBe(custom);
    expect(isTokenStorage(resolveStorage('memory', vi.fn()))).toBe(true);
    expect(getter).not.toHaveBeenCalled();
  });
});
