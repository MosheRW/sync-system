import { useEffect, useRef } from 'react';
import { type Clock, formatShort, useCountdown } from '../../group/countdown.js';
import { useI18n } from '../../i18n/index.js';
import { Button } from './controls.js';
import styles from './group.module.css';

const monotonic: Clock = () => performance.now();

/** "The group is on page {n}." with the page number isolated (design 8). */
function OnPage({ page }: { page: number }) {
  const { t, format } = useI18n();
  const [before, after] = t.groupOnPage.split('{n}');
  return (
    <p className={styles.para}>
      {before}
      <bdi>{format('{n}', { n: page })}</bdi>
      {after}
    </p>
  );
}

/**
 * The jump prompt for a browsing member (design 6.13, AC26, AC27): not
 * modal, never takes focus, one prompt with the latest group page, no
 * timeout. Go to page uses the reading screen's own move.
 */
export function JumpPrompt({
  index,
  onGo,
  onStay,
}: {
  index: number;
  onGo: () => void;
  onStay: () => void;
}) {
  const { t, format } = useI18n();
  return (
    <div role="region" aria-label={t.jumpRegion} className={styles.card}>
      <OnPage page={index + 1} />
      <div className={styles.cardActions}>
        <Button onClick={onStay}>{t.stayHere}</Button>
        <Button variant="primary" onClick={onGo}>
          {format(t.goToPage, { n: index + 1 })}
        </Button>
      </div>
    </div>
  );
}

/**
 * The late-joiner countdown (design 6.14, AC28, AC53): a monotonic deadline
 * re-evaluated on every tick and when the tab is visible again; the bar
 * shrinks through a custom property set with the CSSOM (no `style=` in
 * markup, R12); the seconds are not announced each tick.
 */
export function LateJoinPrompt({
  index,
  deadline,
  totalMs,
  onGo,
  onStay,
  onExpired,
}: {
  index: number;
  deadline: number;
  totalMs: number;
  onGo: () => void;
  onStay: () => void;
  onExpired: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const left = useCountdown(deadline, monotonic) ?? 0;
  const fill = useRef<HTMLDivElement>(null);
  const expired = useRef(false);
  useEffect(() => {
    fill.current?.style.setProperty('--progress', `${Math.max(0, (left / totalMs) * 100)}%`);
    if (left <= 0 && !expired.current) {
      expired.current = true;
      onExpired();
    }
  }, [left, totalMs, onExpired]);
  const [before, after] = t.lateJoinCountdown.split('{time}');
  return (
    <div role="region" aria-label={t.jumpRegion} className={styles.card}>
      <OnPage page={index + 1} />
      <p className={styles.para} aria-live="off">
        {before}
        <bdi dir="ltr">{formatShort(left, i18n)}</bdi>
        {after}
      </p>
      <div className={styles.countdownBar} aria-hidden="true">
        <div ref={fill} className={styles.countdownFill} />
      </div>
      <div className={styles.cardActions}>
        <Button onClick={onStay}>{t.stayHere}</Button>
        <Button variant="primary" onClick={onGo}>
          {t.goNow}
        </Button>
      </div>
    </div>
  );
}
