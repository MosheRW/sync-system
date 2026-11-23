'use client';
import type { QrTicket as CoreQrTicket } from '@mosherw/sync-system-client';
import type { ReactNode } from 'react';
import { useQrTicket } from '../hooks/leader.js';
import type { QrTicketState } from '../types.js';

/**
 * The core's QR ticket type (`{ ticket, expiresAt }`), re-exported under the
 * same name as the component: `QrTicket` is both, like the plan's API.
 */
export type QrTicket = CoreQrTicket;

export interface QrTicketProps {
  /** Run the re-issue timer (default true); `false` while the QR is hidden (R8). */
  enabled?: boolean;
  children: (state: QrTicketState) => ReactNode;
}

/**
 * Unstyled render-prop helper over `useQrTicket` (Q4): renders nothing of
 * its own. The app draws the QR image (for example a deep link with the
 * ticket in the URL fragment).
 */
export function QrTicket({ enabled = true, children }: QrTicketProps): ReactNode {
  const { state } = useQrTicket({ enabled });
  return children(state);
}
