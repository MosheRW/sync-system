'use client';
import { SyncClient, type SyncClientOptions } from '@mosherw/sync-system-client';
import {
  type ReactElement,
  type ReactNode,
  createElement,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SyncContext } from './context.js';
import { type TimerHandle, clearTimer, setTimer } from './host.js';
import { EMPTY_STORE, SyncStore } from './store.js';
import { toSyncError } from './to-sync-error.js';
import type { SyncClientLike } from './types.js';

/** `<SyncProvider>` props (AC4): exactly one of `options` or `client`. */
export type SyncProviderProps =
  | {
      /** Creates and owns a client in the browser, after mount (AC5). Read once (D10). */
      options: SyncClientOptions;
      client?: never;
      /** Connect after mount (default true, Q8). Only ever from `idle` (D4). */
      autoConnect?: boolean;
      children?: ReactNode;
    }
  | {
      /** An app-owned client: used as is, never closed by the provider (AC4). */
      client: SyncClientLike;
      options?: never;
      autoConnect?: boolean;
      children?: ReactNode;
    };

const BOTH_OR_NEITHER =
  '<SyncProvider> needs exactly one of the options or client props (@mosherw/sync-system-react)';
const MODE_SWITCH =
  '<SyncProvider> cannot switch between the options and client props on one mount (@mosherw/sync-system-react)';

interface OwnedEntry {
  readonly store: SyncStore;
  closeTimer: TimerHandle | undefined;
  closed: boolean;
}

/**
 * The owned client's store (D1, D3). The client is created in an effect,
 * never during render, so the server and the first browser render (and
 * hydration) see `EMPTY_STORE`. The cleanup defers `close()` by one tick:
 * StrictMode's simulated unmount re-runs the effect first and cancels it,
 * so one client and one socket survive; a real unmount closes it.
 */
function useOwnedStore(options: SyncClientOptions | undefined): SyncStore {
  const owned = options !== undefined;
  const [store, setStore] = useState<SyncStore>(EMPTY_STORE);
  const entryRef = useRef<OwnedEntry | undefined>(undefined);
  // Read only when a client is created (D10); later changes are ignored.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!owned) return undefined;
    let entry = entryRef.current;
    if (entry?.closeTimer !== undefined) {
      clearTimer(entry.closeTimer);
      entry.closeTimer = undefined;
    }
    if (entry === undefined || entry.closed) {
      entry = { store: createOwnedStore(optionsRef.current), closeTimer: undefined, closed: false };
      entryRef.current = entry;
      setStore(entry.store);
    }
    const current = entry;
    return () => {
      current.closeTimer = setTimer(() => {
        current.closeTimer = undefined;
        current.closed = true;
        current.store.client?.close();
      }, 0);
    };
  }, [owned]);

  return store;
}

/** A store over a new client; invalid options give an inert store with the error (section 9). */
function createOwnedStore(options: SyncClientOptions | undefined): SyncStore {
  try {
    if (options === undefined) throw new TypeError('no options');
    return new SyncStore(new SyncClient(options));
  } catch (error) {
    // INVALID_OPTIONS from the constructor; never retried.
    return new SyncStore(null, toSyncError(error, 'INVALID_OPTIONS'));
  }
}

/**
 * Provides the sync client to the hooks (AC4-AC7). With `options` it owns a
 * client created in the browser after mount and closed on unmount; with
 * `client` it uses the app's client and never closes it. The only automatic
 * `connect()` of the package happens here, and only from `idle` (D4): the
 * core never returns to `idle`, so nothing reconnects after a fatal close,
 * a give-up or a removal.
 */
export function SyncProvider(props: SyncProviderProps): ReactElement {
  const { autoConnect = true, children } = props;
  const owned = props.options !== undefined && props.options !== null;
  const given = props.client !== undefined && props.client !== null;
  if (owned === given) throw new Error(BOTH_OR_NEITHER);
  const modeRef = useRef(owned);
  if (modeRef.current !== owned) throw new Error(MODE_SWITCH);

  const ownedStore = useOwnedStore(owned ? props.options : undefined);
  const client = given ? props.client : undefined;
  const givenStore = useMemo(
    () => (client === undefined ? EMPTY_STORE : new SyncStore(client)),
    [client],
  );
  const store = owned ? ownedStore : givenStore;

  useEffect(() => store.attach(), [store]);

  useEffect(() => {
    const target = store.client;
    if (autoConnect && target !== null && target.getState().status === 'idle') {
      // Errors show in the connection state; the core owns any retry (AC7).
      target.connect().catch(() => undefined);
    }
  }, [store, autoConnect]);

  return createElement(SyncContext.Provider, { value: store }, children);
}
