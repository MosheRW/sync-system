'use client';
import type { SyncClientEvents } from '@sync-system/client';
import { useEffect, useRef } from 'react';
import { useSyncStore } from '../context.js';

/**
 * Subscribes to a core event (AC25) in an effect, always calls the latest
 * `handler` without resubscribing, and unsubscribes on unmount. Nothing on
 * the server (effects do not run) or before the owned client exists.
 */
export function useSyncEvent<E extends keyof SyncClientEvents>(
  event: E,
  handler: (payload: SyncClientEvents[E]) => void,
): void {
  const store = useSyncStore('useSyncEvent');
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const client = store.client;
    if (client === null) return undefined;
    return client.on(event, (payload) => latest.current(payload));
  }, [store, event]);
}
