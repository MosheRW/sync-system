import { type Ref, forwardRef } from 'react';
import { formatClock, useCountdown } from '../../group/countdown.js';
import type { IndicatorKind } from '../../group/phase.js';
import { type I18n, useI18n } from '../../i18n/index.js';
import styles from './group.module.css';

/** The visible text of each indicator state (design 5.2, AC30). Time is filled by the caller. */
export function indicatorText(kind: IndicatorKind, i18n: I18n, graceMs: number | null): string {
  const { t } = i18n;
  switch (kind) {
    case 'group':
      return t.groupButton;
    case 'following':
      return t.indFollowing;
    case 'not-following':
      return t.indNotFollowing;
    case 'leading':
      return t.indLeading;
    case 'previewing':
      return t.indPreviewing;
    case 'reconnecting':
      return t.indReconnecting;
    case 'leader-offline':
      return t.indLeaderOffline;
    case 'leader-grace':
      return i18n.format(t.indLeaderGrace, { time: formatClock(graceMs ?? 0, i18n) });
    case 'awaiting':
      return t.indAwaiting;
    case 'joining':
      return t.indJoining;
    case 'disconnected':
      return t.indDisconnected;
  }
}

const DOT: Record<IndicatorKind, string> = {
  group: 'dotGroup',
  following: 'dotPositive',
  'not-following': 'dotHollow',
  leading: 'dotAccent',
  previewing: 'dotPreview',
  reconnecting: 'dotSpin',
  'leader-offline': 'dotWarning',
  'leader-grace': 'dotWarning',
  awaiting: 'dotHollow',
  joining: 'dotSpinMuted',
  disconnected: 'dotDanger',
};

export interface GroupButtonProps {
  kind: IndicatorKind;
  /** `leader_grace`: local epoch ms the grace ends (from the server's duration, AC53). */
  graceEndsAt?: number | null;
  onOpen: () => void;
}

/**
 * The Group entry point and the connection indicator in one button (design
 * 5.1, 5.2): the visible text is the state (never colour alone); the
 * accessible name adds ", group options". Not a live region itself.
 */
export const GroupButton = forwardRef(function GroupButton(
  { kind, graceEndsAt = null, onOpen }: GroupButtonProps,
  ref: Ref<HTMLButtonElement>,
) {
  const i18n = useI18n();
  const left = useCountdown(kind === 'leader-grace' ? graceEndsAt : null);
  const text = indicatorText(kind, i18n, left);
  const timeIndex = kind === 'leader-grace' ? text.lastIndexOf(' · ') : -1;
  return (
    <button
      ref={ref}
      type="button"
      className={styles.groupButton}
      data-indicator={kind}
      aria-label={i18n.format(i18n.t.groupButtonName, { state: text })}
      onClick={onOpen}
    >
      <span className={`${styles.dot} ${styles[DOT[kind]] ?? ''}`} aria-hidden="true" />
      {timeIndex >= 0 ? (
        <span>
          {text.slice(0, timeIndex + 3)}
          <bdi dir="ltr">{text.slice(timeIndex + 3)}</bdi>
        </span>
      ) : (
        <span>{text}</span>
      )}
    </button>
  );
});
