'use client';
import {
  type ConnectionState,
  type SyncClientError,
  type SyncClientSnapshot,
  type SyncIndicator,
  indicatorOf,
} from '@mosherw/sync-system-client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSyncStore } from '../context.js';
import { useStoreSelector } from '../selector.js';
import type { SyncClientLike, SyncState, UpdateRequired } from '../types.js';
import { sameUpdateRequired, updateRequiredOf } from '../update-required.js';

const pickConnection = (state: SyncState): ConnectionState => state.snapshot.connection;
const pickSnapshot = (state: SyncState): SyncClientSnapshot => state.snapshot;
const pickLastError = (state: SyncState): SyncClientError | null => state.lastError;
const pickState = (state: SyncState): SyncState => state;
const same = <T>(value: T): T => value;
const selectUpdateRequired = (state: SyncState): UpdateRequired | null =>
  updateRequiredOf(state.snapshot, state.lastError);

export interface Connection {
  readonly state: ConnectionState;
  readonly status: ConnectionState['status'];
  /** The PRD sync indicator, via the core `indicatorOf` (AC13). */
  readonly indicator: SyncIndicator;
  /** The last `error` event; cleared when the connection reaches `connected`. */
  readonly lastError: SyncClientError | null;
  /**
   * Calls the core `connect()` (AC7): after a fatal close or a give-up the
   * core waits its backoff first. Never rejects. Call it from a user action.
   */
  readonly connect: () => void;
  /** Same function as `connect`. */
  readonly retry: () => void;
  /** Calls the core `close()`. */
  readonly disconnect: () => void;
}

/** Connection state, indicator, last error and manual connect/retry (AC13, AC7). */
export function useConnection(): Connection {
  const store = useSyncStore('useConnection');
  const state = useStoreSelector(store, pickConnection, same);
  const indicator = useStoreSelector(store, pickSnapshot, indicatorOf);
  const lastError = useStoreSelector(store, pickLastError, same);
  const connect = useCallback(() => {
    // The core's connect() keeps the backoff after fatal closes (#3 M5).
    store.client?.connect().catch(() => undefined);
  }, [store]);
  const disconnect = useCallback(() => {
    store.client?.close();
  }, [store]);
  return useMemo(
    () =>
      Object.freeze({
        state,
        status: state.status,
        indicator,
        lastError,
        connect,
        retry: connect,
        disconnect,
      }),
    [state, indicator, lastError, connect, disconnect],
  );
}

/** The PRD sync indicator (AC13), via the core `indicatorOf`. */
export function useSyncIndicator(): SyncIndicator {
  return useStoreSelector(useSyncStore('useSyncIndicator'), pickSnapshot, indicatorOf);
}

/**
 * "Update required" (AC14): `PROTOCOL_TOO_OLD`, `APP_VERSION_TOO_OLD` or
 * `SERVER_UNSUPPORTED`, typed, with the minimum versions when the server
 * sent them; `null` otherwise.
 */
export function useUpdateRequired(): UpdateRequired | null {
  return useStoreSelector(
    useSyncStore('useUpdateRequired'),
    pickState,
    selectUpdateRequired,
    sameUpdateRequired,
  );
}

/**
 * The client, as an escape hatch: `null` on the server, during hydration and
 * until the provider's effects ran, in both modes (R7). Calling `connect()`
 * or `close()` on it from render or from a state-driven effect bypasses the
 * package's no-auto-retry guarantees: only call them from user actions.
 */
export function useSyncClient(): SyncClientLike | null {
  const store = useSyncStore('useSyncClient');
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted ? store.client : null;
}
