'use client';
import type { SyncClientSnapshot } from '@sync-system/client';
import {
  useCallback,
  useDebugValue,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { useSyncStore } from './context.js';
import type { SyncStore } from './store.js';
import type { SyncState } from './types.js';

const identity = <T>(value: T): T => value;

/**
 * Subscribes to a part of the store (D7, Q6): `pick` chooses the input from
 * the state, `select` derives the value. The value is recomputed only when
 * the picked input changes identity, and kept (same identity) while
 * `isEqual` says the new value equals the last one, so unrelated changes do
 * not re-render (AC11). The server snapshot is `SERVER_STATE` (AC9).
 * Own implementation of the well-known "with selector" memo; no dependency.
 */
export function useStoreSelector<I, T>(
  store: SyncStore,
  pick: (state: SyncState) => I,
  select: (input: I) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const last = useRef<{ readonly value: T } | null>(null);
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const [getSnapshot, getServerSnapshot] = useMemo(() => {
    let memo: { readonly input: I; readonly value: T } | null = null;
    const compute = (state: SyncState): T => {
      const input = pick(state);
      if (memo !== null && Object.is(memo.input, input)) return memo.value;
      const next = select(input);
      const previous = memo ?? last.current;
      const value = previous !== null && isEqual(previous.value, next) ? previous.value : next;
      memo = { input, value };
      return value;
    };
    return [() => compute(store.getState()), () => compute(store.getServerState())];
  }, [store, pick, select, isEqual]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    last.current = { value };
  }, [value]);
  return value;
}

/** `useStoreSelector` over the provider's store, for the package's hooks. */
export function useSyncState<I, T = I>(
  hookName: string,
  pick: (state: SyncState) => I,
  select: (input: I) => T = identity as (input: I) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  return useStoreSelector(useSyncStore(hookName), pick, select, isEqual);
}

const pickSnapshot = (state: SyncState): SyncClientSnapshot => state.snapshot;

/** The core snapshot (AC9): same identity until it changes. */
export function useSyncSnapshot(): SyncClientSnapshot {
  const snapshot = useSyncState('useSyncSnapshot', pickSnapshot);
  useDebugValue(snapshot.connection.status);
  return snapshot;
}

/**
 * A value derived from the core snapshot (AC11). Re-renders only when the
 * selected value changes (`Object.is`, or `isEqual`); an unchanged selection
 * keeps its identity. Inline selectors are fine.
 */
export function useSyncSelector<T>(
  selector: (snapshot: SyncClientSnapshot) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  return useSyncState('useSyncSelector', pickSnapshot, selector, isEqual);
}
