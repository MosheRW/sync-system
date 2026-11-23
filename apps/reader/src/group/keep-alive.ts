import type { HandoffMode, KeepAliveEvent } from '@mosherw/sync-system-react';
import type { Messages } from '../i18n/en.js';

/**
 * The keep-alive card's state and copy (#25 architecture 8.3, design F19,
 * 6.7, D2). Pure.
 */
export type KeepAliveState = 'counting' | 'last-chance' | 'paused';

export interface KeepAliveInput {
  /** Time left on the countdown (local, from the server's duration). */
  readonly remainingMs: number;
  /** The led group's handoff mode, `null` when unknown. */
  readonly handoff: HandoffMode | null;
  /** Connected roster entries other than the leader. */
  readonly othersHere: number;
  /** This tab leads because of a missed keep-alive and hasn't been active since (D2b). */
  readonly lastChance: boolean;
}

export interface KeepAliveView {
  readonly state: KeepAliveState;
  readonly titleKey: keyof Messages;
  /** `keepAliveBody` and `keepAliveBodyLast` have `{time}`. */
  readonly bodyKey: keyof Messages;
}

export function keepAliveView(input: KeepAliveInput): KeepAliveView {
  if (input.lastChance) {
    // No paused state: at 0:00 the group ends (#13 escalation) and 8a's notice explains.
    return { state: 'last-chance', titleKey: 'keepAliveTitle', bodyKey: 'keepAliveBodyLast' };
  }
  if (input.remainingMs > 0) {
    return { state: 'counting', titleKey: 'keepAliveTitle', bodyKey: 'keepAliveBody' };
  }
  const handsOver = input.handoff === 'auto' && input.othersHere > 0;
  return {
    state: 'paused',
    titleKey: 'keepAlivePausedTitle',
    bodyKey: handsOver ? 'keepAlivePausedHandoff' : 'keepAlivePausedWait',
  };
}

/** The longest countdown the reader believes (#25 R22, L2); the server's is 1 minute. */
export const MAX_COUNTDOWN_MS = 10 * 60_000;

/**
 * The prompt's local deadline (epoch ms) with the server's duration clamped
 * to `[0, MAX_COUNTDOWN_MS]`; a duration that isn't a finite number counts
 * as 0 (the card shows its run-out state at once).
 */
export function keepAliveDeadline(prompt: KeepAliveEvent, now: number = Date.now()): number {
  const raw = prompt.countdownMs;
  const ms = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), MAX_COUNTDOWN_MS) : 0;
  const received = prompt.deadlineAt - raw;
  return (Number.isFinite(received) ? received : now) + ms;
}
