import { type JoinCodes, useGroupLock } from '@mosherw/sync-system-react';
import { type ReactNode, useId } from 'react';
import { formatClock, useCountdown } from '../../group/countdown.js';
import { leaderActionError } from '../../group/leader-errors.js';
import { useActionError } from '../../group/use-retry-wait.js';
import { useI18n } from '../../i18n/index.js';
import { PlainText } from '../PlainText.js';
import { CodeDisplay } from './CodeDisplay.js';
import { ActionErrorLine, Button } from './controls.js';
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

/** A lock icon (inline SVG, #25 design 10). */
export function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={styles.inlineIcon}>
      <path
        d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v10H5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "Locked: nobody new can join." (leader) or the member's line (#25 design 6.5). */
export function LockLine({ member = false }: { member?: boolean }) {
  const { t } = useI18n();
  return (
    <p className={styles.lockLine}>
      <LockIcon />
      {member ? t.lockedMemberLine : t.lockedLeaderLine}
    </p>
  );
}

/**
 * Lock / Unlock group (#25 design 6.5, F18, AC44): no confirmation; the
 * label says the action; errors under the button (design 7.11).
 */
export function LockControl({
  announce,
  onActivity,
}: {
  announce: (text: string) => void;
  /** A leader action succeeded (#25 8.3). */
  onActivity?: () => void;
}) {
  const { t } = useI18n();
  const lock = useGroupLock();
  const error = useActionError();
  const hintId = useId();
  const action = lock.locked ? lock.unlock : lock.lock;
  const run = () => {
    const locking = !lock.locked;
    error.clear();
    void action.run().then((result) => {
      if (result.ok) {
        onActivity?.();
        announce(locking ? t.announceLocked : t.announceUnlocked);
        return;
      }
      error.set(leaderActionError(locking ? 'lock' : 'unlock', result.error));
    });
  };
  return (
    <>
      <Button
        pending={action.pending}
        pendingLabel={lock.locked ? t.unlocking : t.locking}
        inactive={error.waitLeft > 0}
        onClick={run}
        {...(lock.locked ? {} : { 'aria-describedby': hintId })}
      >
        {lock.locked ? t.unlockGroup : t.lockGroup}
      </Button>
      {lock.locked ? null : (
        <p id={hintId} className={styles.muted}>
          {t.lockHint}
        </p>
      )}
      <ActionErrorLine state={error} />
    </>
  );
}

/**
 * "Preview pages" with its hint, or "Return to group" while previewing
 * (#25 design 5.2, 5.3, U6).
 */
export function PreviewControl({
  active,
  onStart,
  onReturn,
}: {
  active: boolean;
  onStart: () => void;
  onReturn: () => void;
}) {
  const { t } = useI18n();
  const hintId = useId();
  if (active) return <Button onClick={onReturn}>{t.returnToGroup}</Button>;
  return (
    <>
      <Button aria-describedby={hintId} onClick={onStart}>
        {t.previewStart}
      </Button>
      <p id={hintId} className={styles.muted}>
        {t.previewStartHint}
      </p>
    </>
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
  counter,
  locked = false,
}: {
  codes: JoinCodes;
  pausedUntil: number | null;
  qrButton?: ReactNode;
  /** The people counter (#25 design 6.1), before the QR button. */
  counter?: ReactNode;
  /** The lock line under the codes (#25 design 5.1). */
  locked?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div role="region" aria-label={t.codesRegion} className={styles.strip}>
      <div className={styles.stripInner}>
        {qrOnly(codes) ? <span>{t.qrOnlyStrip}</span> : <LeaderCodes codes={codes} />}
        {counter}
        {qrButton !== undefined ? <span className={styles.stripQr}>{qrButton}</span> : null}
        {locked ? <LockLine /> : null}
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
  /** The leader sheet's People row (#25 design 5.3), before the actions. */
  peopleRow?: ReactNode;
  /** The panel's People section (#25 design 5.2), the last section. */
  people?: ReactNode;
  /** The group is locked: the lock line (#25 design 6.5). */
  locked?: boolean;
  /** Leader controls before Get new codes: Preview pages, Lock (#25 design 5.2, 5.3). */
  controls?: ReactNode;
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
  peopleRow,
  people,
  locked = false,
  controls,
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
      {locked ? <LockLine /> : null}
      {pausedUntil !== null ? <PauseLine retryAt={pausedUntil} /> : null}
      {name !== null ? (
        <p className={styles.para}>
          {format(t.yourName, { name: '\u0000' }).split('\u0000')[0]}
          <PlainText text={name} dir="auto" maxLength={32} />
        </p>
      ) : null}
      {peopleRow}
      {controls}
      <Button pending={rotatePending} pendingLabel={t.rotating} onClick={onRotate}>
        {t.newCodes}
      </Button>
      <Button variant="danger" pending={endPending} pendingLabel={t.ending} onClick={onEnd}>
        {t.endGroup}
      </Button>
      {people}
    </div>
  );
}
