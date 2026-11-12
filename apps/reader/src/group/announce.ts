import { useCallback, useState } from 'react';
import type { I18n } from '../i18n/index.js';
import { formatLong } from './countdown.js';
import type { IndicatorKind } from './phase.js';

/** A message for the shared polite live region; `id` makes a repeat count again. */
export interface Announcement {
  readonly text: string;
  readonly id: number;
}

/** `announce(text)` for the reading screen's live region (design 9). */
export function useAnnouncer(): [Announcement | null, (text: string) => void] {
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  const announce = useCallback((text: string) => {
    setAnnouncement((prev) => ({ text, id: (prev?.id ?? 0) + 1 }));
  }, []);
  return [announcement, announce];
}

/**
 * What to announce when the indicator changes (design 5.2), or `null`.
 * `leadingAnnounced`: "You're leading" was already said for this group.
 */
export function indicatorAnnouncement(
  prev: IndicatorKind | null,
  next: IndicatorKind,
  i18n: I18n,
  options: {
    graceMs: number | null;
    leadingAnnounced: boolean;
    /** The group's page (0-based) for "Preview on" (#25 F15.2). */
    groupIndex?: number | null;
  },
): string | null {
  const { t } = i18n;
  if (prev === next) return null;
  switch (next) {
    case 'following':
      if (prev === 'reconnecting') return t.announceBack;
      if (prev === 'leader-offline' || prev === 'leader-grace') return t.announceLeaderBack;
      return t.announceFollowing;
    case 'not-following':
      return t.announceNotFollowing;
    case 'leading':
      if (prev === 'reconnecting') return t.announceBack;
      // Leaving preview: its exit announcement covers it (#25 design 6.11).
      if (prev === 'previewing') return null;
      return options.leadingAnnounced ? null : t.announceLeading;
    case 'previewing':
      if (prev === 'reconnecting') return t.announceBack;
      return i18n.format(t.announcePreviewOn, { n: (options.groupIndex ?? 0) + 1 });
    case 'reconnecting':
      // A reload shows Reconnecting… at once; only a lost connection is news.
      return prev === null || prev === 'group' || prev === 'joining'
        ? null
        : t.announceReconnecting;
    case 'leader-offline':
      return t.announceLeaderOffline;
    case 'leader-grace':
      return i18n.format(t.announceLeaderGrace, {
        time: formatLong(options.graceMs ?? 0, i18n),
      });
    case 'awaiting':
      return t.announceAwaiting;
    case 'disconnected':
      return t.announceDisconnected;
    case 'group':
    case 'joining':
      return null;
  }
}
