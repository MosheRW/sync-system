import type { StorageLike } from '../../src/group/session-store.js';

/** A Map-backed Web Storage stand-in, with its items visible to tests. */
export class MemoryStorage implements StorageLike {
  readonly items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  /** Every key, sorted. */
  keys(): string[] {
    return [...this.items.keys()].sort();
  }
}

/** A storage whose every call throws, like a revoked or blocked one. */
export const THROWING_STORAGE: StorageLike = {
  getItem: () => {
    throw new DOMException('blocked', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('full', 'QuotaExceededError');
  },
  removeItem: () => {
    throw new DOMException('blocked', 'SecurityError');
  },
};
