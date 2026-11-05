'use client';
import { createContext, useContext } from 'react';
import type { SyncStore } from './store.js';

/** The provider's store. `null` outside `<SyncProvider>`. */
export const SyncContext = createContext<SyncStore | null>(null);
SyncContext.displayName = 'SyncContext';

/**
 * The store of the nearest `<SyncProvider>`. Throws a fixed message naming
 * the hook and the provider outside one (AC8); `hookName` is always a
 * literal from this package, never app data (R10).
 */
export function useSyncStore(hookName: string): SyncStore {
  const store = useContext(SyncContext);
  if (store === null) {
    throw new Error(`${hookName} must be used inside <SyncProvider> (@sync-system/react)`);
  }
  return store;
}
