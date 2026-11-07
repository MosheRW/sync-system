import type { JoinCodes } from '@sync-system/react';
import type { ReactNode } from 'react';
import { formatClock, useCountdown } from '../../group/countdown.js';
import { useI18n } from '../../i18n/index.js';
import { PlainText } from '../PlainText.js';
import { CodeDisplay } from './CodeDisplay.js';
import { Button } from './controls.js';
import styles from './group.module.css';

/** The leader's codes, by the group's methods (design 4.2 table, AC8). */
export function LeaderCodes({ codes, large = false }: { codes: JoinCodes; large?: boolean }) {
  const { t } = useI18n();
  const short = !large;
  return (
    <>
      {codes.groupCode !== undefined ? (
        <CodeDisplay
          label={short ? t.groupCodeShort : t.groupCodeLabel}
          spokenLabel={t.groupCodeLabel}
          code={codes.groupCode}
          large={large}
        />
      ) : null}
      {codes.doorCode !== undefined ? (
        <CodeDisplay
          label={short ? t.doorCodeShort : t.doorCodeLabel}
          spokenLabel={t.doorCodeLabel}
          code={codes.doorCode}
          large={large}
        />
      ) : null}
      {codes.alphaCode !== undefined ? (
        <CodeDisplay label={t.alphaCodeLabel} code={codes.alphaCode} large={large} />
      ) : null}
    </>
  );
}

/** True when the group has no typed code (method D only). */
export function qrOnly(codes: JoinCodes): boolean {
  return (
    codes.groupCode === undefined && codes.doorCode === undefined && codes.alphaCode === undefined
  );
}

/** "Joining with the door code is paused. 4:59 left." (design F10.3, AC11, AC53). */
export function PauseLine({ retryAt }: { retryAt: number }) {
  const i18n = useI18n();
  const left = useCountdown(retryAt) ?? 0;
  const text = i18n.format(i18n.t.joinPausedLeader, { time: '\u0000' });
  const [before, after] = text.split('\u0000');
  return (
    <p className={styles.warningLine}>
      {before}
      <bdi dir="ltr">{formatClock(left, i18n)}</bdi>
      {after}
    </p>
  );
}

/**
 * The code strip under the header, phones and tablets (design 4.2, 6.6):
 * always visible while leading, never truncated (it wraps). The QR button
 * sits at the inline end.
 */
export function CodeStrip({
  codes,
  pausedUntil,
  qrButton,
}: {
  codes: JoinCodes;
  pausedUntil: number | null;
  qrButton?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div role="region" aria-label={t.codesRegion} className={styles.strip}>
      <div className={styles.stripInner}>
        {qrOnly(codes) ? <span>{t.qrOnlyStrip}</span> : <LeaderCodes codes={codes} />}
        {qrButton !== undefined ? <span className={styles.stripQr}>{qrButton}</span> : null}
        {pausedUntil !== null ? <PauseLine retryAt={pausedUntil} /> : null}
      </div>
    </div>
  );
}

export interface LeaderDetailsProps {
  codes: JoinCodes | null;
  pausedUntil: number | null;
  /** This user's own name, already localised. */
  name: string | null;
  qr?: ReactNode;
  rotatePending: boolean;
  endPending: boolean;
  onRotate: () => void;
  onEnd: () => void;
  /** Codes notice or join requests on large screens (design 4.3). */
  top?: ReactNode;
}

/** The leader's group: codes, QR, name, pause line and actions (design 4.3, 6.5). */
export function LeaderDetails({
  codes,
  pausedUntil,
  name,
  qr,
  rotatePending,
  endPending,
  onRotate,
  onEnd,
  top,
}: LeaderDetailsProps) {
  const { t, format } = useI18n();
  return (
    <div className={styles.stack}>
      {top}
      {codes !== null ? (
        <div className={styles.stack}>
          {qrOnly(codes) ? <p className={styles.para}>{t.qrOnlyStrip}</p> : null}
          <LeaderCodes codes={codes} large />
        </div>
      ) : null}
      {qr}
      {pausedUntil !== null ? <PauseLine retryAt={pausedUntil} /> : null}
      {name !== null ? (
        <p className={styles.para}>
          {format(t.yourName, { name: '\u0000' }).split('\u0000')[0]}
          <PlainText text={name} dir="auto" maxLength={32} />
        </p>
      ) : null}
      {/* 8b (#25): members, vice-leader, lock and remove go here (design 11). */}
      <Button pending={rotatePending} pendingLabel={t.rotating} onClick={onRotate}>
        {t.newCodes}
      </Button>
      <Button variant="danger" pending={endPending} pendingLabel={t.ending} onClick={onEnd}>
        {t.endGroup}
      </Button>
    </div>
  );
}
