'use client';
import { SyncClientError } from '@sync-system/client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSyncStore } from './context.js';
import type { SyncStore } from './store.js';
import { toSyncError } from './to-sync-error.js';
import type { ActionResult, ActionState, SyncClientLike } from './types.js';

export { toSyncError } from './to-sync-error.js';

interface Status<T> {
  readonly pending: boolean;
  readonly error: SyncClientError | null;
  readonly value: T | undefined;
}

const INITIAL: Status<never> = Object.freeze({ pending: false, error: null, value: undefined });

/** The result of an action on a store without a client (server, before mount). */
export function notConnectedResult(): Extract<ActionResult<never>, { ok: false }> {
  return Object.freeze({ ok: false as const, error: new SyncClientError('NOT_CONNECTED') });
}

/**
 * The action machinery behind every action hook (D8). `run` has a stable
 * identity, never rejects (a rejected promise and a synchronous throw both
 * become `{ ok: false, error }`), skips state updates after unmount, and a
 * newer call supersedes an older one's state update. Arguments are never
 * kept in state. When `resetKey` changes from a non-null value (the role or
 * group the value belongs to is gone), the value and error are dropped and
 * in-flight results are ignored (R3).
 */
export function useStoreAction<A extends unknown[], T>(
  store: SyncStore,
  fn: (client: SyncClientLike, ...args: A) => Promise<T> | T,
  resetKey: unknown = null,
): ActionState<A, T> {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [status, setStatus] = useState<Status<T>>(INITIAL);
  const mounted = useRef(false);
  const calls = useRef(0);
  const key = useRef(resetKey);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const previous = key.current;
    key.current = resetKey;
    if (previous !== null && previous !== undefined && !Object.is(previous, resetKey)) {
      calls.current += 1;
      setStatus(INITIAL);
    }
  }, [resetKey]);

  const run = useCallback(
    async (...args: A): Promise<ActionResult<T>> => {
      const id = ++calls.current;
      const update = (next: Status<T>) => {
        if (mounted.current && id === calls.current) setStatus(next);
      };
      const client = store.client;
      if (client === null) {
        const result = notConnectedResult();
        update({ pending: false, error: result.error, value: undefined });
        return result;
      }
      update({ pending: true, error: null, value: undefined });
      try {
        const value = await fnRef.current(client, ...args);
        update({ pending: false, error: null, value });
        return Object.freeze({ ok: true as const, value });
      } catch (caught) {
        const error = toSyncError(caught);
        update({ pending: false, error, value: undefined });
        return Object.freeze({ ok: false as const, error });
      }
    },
    [store],
  );

  const reset = useCallback(() => {
    calls.current += 1;
    if (mounted.current) setStatus(INITIAL);
  }, []);

  return useMemo(
    () =>
      Object.freeze({
        run,
        pending: status.pending,
        error: status.error,
        value: status.value,
        reset,
      }),
    [run, reset, status],
  );
}

/**
 * A custom action over the client (D8): `run(...args)` calls
 * `fn(client, ...args)` and resolves `{ ok: true, value }` or
 * `{ ok: false, error }` (a typed `SyncClientError`); it never rejects.
 * Without a client (server, before mount) it resolves `NOT_CONNECTED`.
 */
export function useSyncAction<A extends unknown[], T>(
  fn: (client: SyncClientLike, ...args: A) => Promise<T> | T,
): ActionState<A, T> {
  return useStoreAction(useSyncStore('useSyncAction'), fn);
}
