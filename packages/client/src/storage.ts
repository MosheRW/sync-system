import { localStorageGlobal } from './host.js';
import { type LogFields, type LogLevel } from './logger.js';

/**
 * Where the client keeps participant tokens and leader recovery data (#5
 * AC32). The method names match Web Storage, so `localStorage`,
 * `sessionStorage`, React Native `AsyncStorage` and simple Map wrappers fit
 * as they are. Sync or async: the client always awaits.
 */
export interface TokenStorage {
  getItem(key: string): string | null | undefined | Promise<string | null | undefined>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** The `storage` option: a custom store, the browser's `localStorage`, or memory only. */
export type StorageOption = TokenStorage | 'local' | 'memory';

/** An in-memory store (lost when the page or process goes away). */
export function memoryStorage(): TokenStorage {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

/** True for an object with the three storage methods. */
export function isTokenStorage(value: unknown): value is TokenStorage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.getItem === 'function' &&
    typeof candidate.setItem === 'function' &&
    typeof candidate.removeItem === 'function'
  );
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export type StorageLog = (level: LogLevel, event: string, fields?: LogFields) => void;

/**
 * Turns the option into a store. `'local'` is resolved here, on the first
 * storage operation, never at import or construction (#3 AC7). The global
 * lookup runs inside try/catch, since sandboxed iframes and some private
 * modes throw on access; when it is missing or throws, an in-memory store is
 * used and a warning is logged with the error name only (AC32).
 */
export function resolveStorage(option: StorageOption, log: StorageLog): TokenStorage {
  if (option === 'memory') return memoryStorage();
  if (option !== 'local') return option;
  try {
    const local = localStorageGlobal();
    if (isTokenStorage(local)) return local;
    log('warn', 'storage_unavailable', { name: 'missing' });
  } catch (error) {
    log('warn', 'storage_unavailable', { name: errorName(error) });
  }
  return memoryStorage();
}

/** Error name for storage failure logs. */
export function storageErrorName(error: unknown): string {
  return errorName(error);
}
