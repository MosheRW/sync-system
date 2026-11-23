'use client';
import type { ConnectionState, SyncIndicator } from '@mosherw/sync-system-client';
import type { ReactNode } from 'react';
import { useConnection } from '../hooks/connection.js';

export interface ConnectionIndicatorRenderProps {
  readonly indicator: SyncIndicator;
  readonly status: ConnectionState['status'];
  /** Manual retry through the core `connect()` (AC7). */
  readonly retry: () => void;
}

export interface ConnectionIndicatorProps {
  children: (props: ConnectionIndicatorRenderProps) => ReactNode;
}

/** Unstyled render-prop helper (Q4): renders nothing of its own. */
export function ConnectionIndicator({ children }: ConnectionIndicatorProps): ReactNode {
  const { indicator, status, retry } = useConnection();
  return children({ indicator, status, retry });
}
