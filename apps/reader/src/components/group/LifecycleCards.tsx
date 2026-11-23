import {
  type HandoffMode,
  type KeepAliveEvent,
  useKeepAlive,
  useLeadership,
} from '@mosherw/sync-system-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { formatLong, formatShort, useCountdown } from '../../group/countdown.js';
import { keepAliveDeadline, keepAliveView } from '../../group/keep-alive.js';
import { leaderActionError } from '../../group/leader-errors.js';
import { useActionError } from '../../group/use-retry-wait.js';
import { useI18n } from '../../i18n/index.js';
import { ActionErrorLine, Button } from './controls.js';
import styles from './group.module.css';
import { Template } from './Template.js';

/**
 * A card that goes while focus is inside it sends focus to `target` (the
 * article, design 9.1), never to `body`.
 */
export function useFocusOnClose(
  ref: { readonly current: HTMLElement | null },
  target: () => void,
): void {
  const targetRef = useRef(target);
  targetRef.current = target;
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      if (element?.contains(document.activeElement) !== true) return;
      queueMicrotask(() => {
        if (document.activeElement === null || document.activeElement === document.body) {
          targetRef.current();
        }
      });
    };
  }, [ref]);
}

function WarningIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={styles.inlineIcon}>
      <path
        d="M12 3l10 18H2zM12 10v5M12 18v.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The keep-alive card (#25 design 6.7, F19, AC45, AC53): not modal, never
 * takes focus. The countdown comes from the server's duration on a local
 * deadline, recomputed every tick and on `visibilitychange`; it is not
 * announced per tick. Announced assertively on appearance and once at
 * run-out (U13). At run-out the card stays, paused, with the same Keep going
 * (the server accepts it during the pause).
 */
export function KeepAliveCard({
  prompt,
  handoff,
  othersHere,
  lastChance,
  announce,
  announceAssertive,
  onActivity,
  onClosedWithFocus,
}: {
  prompt: KeepAliveEvent;
  handoff: HandoffMode | null;
  othersHere: number;
  lastChance: boolean;
  announce: (text: string) => void;
  announceAssertive: (text: string) => void;
  /** This tab answered: a leader activity (the last-chance hint goes, 8.3). */
  onActivity: () => void;
  onClosedWithFocus: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const { answer } = useKeepAlive();
  const error = useActionError();
  const deadline = keepAliveDeadline(prompt);
  const left = useCountdown(deadline) ?? 0;
  const view = keepAliveView({ remainingMs: left, handoff, othersHere, lastChance });
  const cardRef = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  useFocusOnClose(cardRef, onClosedWithFocus);

  // Assertive, once on appearance (per prompt) and once at run-out (design 9.2).
  const appeared = useRef<KeepAliveEvent | null>(null);
  useEffect(() => {
    if (appeared.current === prompt) return;
    appeared.current = prompt;
    const ms = Math.max(0, deadline - Date.now());
    announceAssertive(
      i18n.format(lastChance ? t.announceKeepAliveLast : t.announceKeepAlive, {
        time: formatLong(ms, i18n),
      }),
    );
    // Only on a new prompt.
  }, [prompt]);
  const paused = view.state === 'paused';
  const pausedSaid = useRef(false);
  useEffect(() => {
    if (!paused || pausedSaid.current) return;
    pausedSaid.current = true;
    announceAssertive(t.announcePaused);
  }, [paused, announceAssertive, t.announcePaused]);

  const total = Math.max(1, deadline - (prompt.deadlineAt - prompt.countdownMs));
  useEffect(() => {
    fill.current?.style.setProperty('--progress', `${Math.max(0, (left / total) * 100)}%`);
  }, [left, total]);

  const keepGoing = () => {
    error.clear();
    onActivity();
    void answer.run().then((result) => {
      if (result.ok) {
        announce(t.announceKeptGoing);
        return;
      }
      error.set(leaderActionError('keepAlive', result.error));
    });
  };

  return (
    <div
      ref={cardRef}
      role="region"
      aria-label={t.keepAliveRegion}
      className={`${styles.card} ${paused ? styles.cardWarning : ''}`}
    >
      <p className={paused ? styles.cardTitleWarning : styles.cardTitle}>
        {paused ? <WarningIcon /> : null}
        {t[view.titleKey]}
      </p>
      <p className={styles.para} aria-live="off">
        {paused ? (
          t[view.bodyKey]
        ) : (
          <Template
            text={t[view.bodyKey]}
            values={{ time: <bdi dir="ltr">{formatShort(left, i18n)}</bdi> }}
          />
        )}
      </p>
      {paused ? null : (
        <div className={styles.countdownBar} aria-hidden="true">
          <div ref={fill} className={styles.countdownFill} />
        </div>
      )}
      <ActionErrorLine state={error} />
      <div className={styles.cardActionsEnd}>
        <Button
          variant="primary"
          pending={answer.pending}
          pendingLabel={t.keepingGoing}
          inactive={error.waitLeft > 0}
          onClick={keepGoing}
        >
          {t.keepGoing}
        </Button>
      </div>
    </div>
  );
}

/**
 * "Take the lead back?" (#25 design 6.10, F21, AC48): not modal, never takes
 * focus, announced politely once. Take the lead runs the core's take-back;
 * `NOT_ALLOWED` closes the card (the offer is gone) and the caller shows the
 * sticky refused banner; other errors stay inline.
 */
export function TakeBackCard({
  announce,
  onDecline,
  onRefused,
  onClosedWithFocus,
}: {
  announce: (text: string) => void;
  onDecline: () => void;
  onRefused: () => void;
  onClosedWithFocus: () => void;
}) {
  const { t } = useI18n();
  const { takeBack } = useLeadership();
  const error = useActionError();
  const cardRef = useRef<HTMLDivElement>(null);
  useFocusOnClose(cardRef, onClosedWithFocus);
  useEffect(() => {
    announce(t.announceTakeBack);
    // Once, on appearance.
  }, []);
  const take = () => {
    error.clear();
    void takeBack.run().then((result) => {
      if (result.ok) return;
      const failure = leaderActionError('takeBack', result.error);
      if (failure?.refused === true) {
        onRefused();
        return;
      }
      error.set(failure);
    });
  };
  return (
    <div ref={cardRef} role="region" aria-label={t.takeBackRegion} className={styles.card}>
      <p className={styles.cardTitle}>{t.takeBackTitle}</p>
      <p className={styles.para}>{t.takeBackBody}</p>
      <ActionErrorLine state={error} />
      <div className={styles.cardActions}>
        <Button inactive={takeBack.pending} onClick={onDecline}>
          {t.takeBackNo}
        </Button>
        <Button
          variant="primary"
          pending={takeBack.pending}
          pendingLabel={t.takingBack}
          inactive={error.waitLeft > 0}
          onClick={take}
        >
          {t.takeBackYes}
        </Button>
      </div>
    </div>
  );
}
