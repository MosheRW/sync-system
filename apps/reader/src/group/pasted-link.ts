import { useEffect, useSyncExternalStore } from 'react';

/**
 * "A QR link was pasted into this open tab and not used" (#25 AC57, R20).
 * A counter and nothing else: the ticket never reaches it (the strip runs
 * first and the callback takes no arguments), so nothing here can store,
 * show or use it.
 */
export interface PastedLinkSignal {
  /** One more pasted link was stripped. No arguments by design. */
  readonly notify: () => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly count: () => number;
  /** True once per new paste since the last call: the notice should show. */
  readonly take: () => boolean;
}

export function createPastedLinkSignal(): PastedLinkSignal {
  let count = 0;
  let seen = 0;
  const listeners = new Set<() => void>();
  return {
    notify: () => {
      count += 1;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    count: () => count,
    take: () => {
      if (count === seen) return false;
      seen = count;
      return true;
    },
  };
}

/**
 * Calls `onPasted` for each new paste while `enabled` (a page with a place
 * for the notice); a paste while disabled shows when it is enabled again.
 */
export function usePastedLinkNotice(
  signal: PastedLinkSignal,
  enabled: boolean,
  onPasted: () => void,
): void {
  const count = useSyncExternalStore(signal.subscribe, signal.count, signal.count);
  useEffect(() => {
    if (enabled && signal.take()) onPasted();
    // `onPasted` is read when a new paste arrives, not a reason to check again.
  }, [count, enabled, signal]);
}
