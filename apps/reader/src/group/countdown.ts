import { useEffect, useState } from 'react';
import type { I18n } from '../i18n/index.js';

/**
 * Countdowns (#24 AC53): every target time is a local time the client
 * computed from a server **duration** (never a server timestamp). The
 * remaining time is recomputed from the clock on every tick and when the tab
 * becomes visible again, so it is right after the tab was in the background.
 */

export type Clock = () => number;

const TICK_MS = 250;

/**
 * Milliseconds left until `target` on `clock` (default `Date.now`, for the
 * client's epoch times), or `null` without a target. Never negative.
 */
export function useCountdown(target: number | null, clock: Clock = Date.now): number | null {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    if (target === null) return undefined;
    const update = () => setNow(clock());
    update();
    const timer = setInterval(update, TICK_MS);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [target, clock]);
  return target === null ? null : Math.max(0, target - now);
}

const wholeSeconds = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

/** `m:ss` (design 7.1 `durationClock`), as in "Waiting for leader · 0:24". */
export function formatClock(ms: number, i18n: I18n): string {
  const total = wholeSeconds(ms);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return i18n.format(i18n.t.durationClock, {
    m: minutes,
    ss: String(seconds).padStart(2, '0'),
  });
}

/** `{s} s` under a minute, else `m:ss` (design 7.1). */
export function formatShort(ms: number, i18n: I18n): string {
  const total = wholeSeconds(ms);
  return total < 60 ? i18n.format(i18n.t.durationSeconds, { s: total }) : formatClock(ms, i18n);
}

/** Words for announcements: "24 seconds", "3 minutes" (rounded up). */
export function formatLong(ms: number, i18n: I18n): string {
  const total = wholeSeconds(ms);
  if (total < 60) {
    return total === 1 ? i18n.t.secondsLongOne : i18n.format(i18n.t.secondsLong, { n: total });
  }
  const minutes = Math.ceil(total / 60);
  return minutes === 1 ? i18n.t.minutesLongOne : i18n.format(i18n.t.minutesLong, { n: minutes });
}
