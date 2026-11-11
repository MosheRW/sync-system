import type { RosterEntry } from '@sync-system/react';
import { type Ref, forwardRef, useId, useLayoutEffect, useRef } from 'react';
import { rosterNameText } from '../../group/names.js';
import {
  countRoster,
  counterKey,
  orderRoster,
  rowDetails,
  type RosterCounts,
} from '../../group/roster-view.js';
import { type I18n, useI18n } from '../../i18n/index.js';
import { PlainText } from '../PlainText.js';
import styles from './group.module.css';
import { Num, Template } from './Template.js';

/** "5 here, 2 away" with each number in its own isolate (design 6.1). */
function CounterText({ counts }: { counts: RosterCounts }) {
  const { t, lang } = useI18n();
  return (
    <Template
      text={t[counterKey(counts)]}
      values={{
        here: <Num value={counts.here} lang={lang} />,
        away: <Num value={counts.away} lang={lang} />,
      }}
    />
  );
}

/** The counter wording as plain text (for the button's accessible name). */
function counterString(counts: RosterCounts, i18n: I18n): string {
  return i18n.format(i18n.t[counterKey(counts)], { here: counts.here, away: counts.away });
}

function PeopleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={styles.inlineIcon}>
      <path
        d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm-6 9c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14.5c1.8.8 3 2.6 3 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * The people counter in the code strip, < 1024 px (#25 design 6.1, AC38):
 * not rendered before the first roster (the own row is always on a real
 * roster, so an empty one is "loading"); not a live region.
 */
export const PeopleCounter = forwardRef(function PeopleCounter(
  { roster, onOpen }: { roster: readonly RosterEntry[]; onOpen: () => void },
  ref: Ref<HTMLButtonElement>,
) {
  const i18n = useI18n();
  if (roster.length === 0) return null;
  const counts = countRoster(roster);
  return (
    <button
      ref={ref}
      type="button"
      className={`${styles.textButton} ${styles.counterButton}`}
      aria-label={i18n.format(i18n.t.peopleCounterName, { counter: counterString(counts, i18n) })}
      onClick={onOpen}
    >
      <PeopleIcon />
      <span>
        <CounterText counts={counts} />
      </span>
    </button>
  );
});

/** "People   5 here, 2 away   [Show people]" in the leader sheet (design 5.3). */
export function PeopleRow({
  roster,
  onShow,
}: {
  roster: readonly RosterEntry[];
  onShow: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className={styles.peopleRow}>
      <span className={styles.label}>{t.peopleLabel}</span>
      {roster.length > 0 ? (
        <span className={styles.muted}>
          <CounterText counts={countRoster(roster)} />
        </span>
      ) : null}
      <button type="button" className={styles.textButton} onClick={onShow}>
        {t.showPeople}
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
          className={styles.forwardIcon}
        >
          <path
            d="M9 5l7 7-7 7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
}

export interface RosterListProps {
  roster: readonly RosterEntry[];
  /** The vice-leader's participant ID (leader view), for the role column. */
  viceId: string | null;
  /** Offline: the last rows stay with a muted line (design 6.2 reconnecting). */
  stale: boolean;
  /** Focus was inside the list when it unmounted (resize below 1024 px, design F14.4). */
  onUnmountWithFocus?: () => void;
}

/**
 * The people in the group (#25 design 6.2, AC38, AC39, AC61): the own row
 * first, then the roster's own order. Names are text through `PlainText`
 * (#24 R7, #25 R15); element IDs come from `useId()`, never from a
 * participant ID or a name (L5).
 */
export function RosterList({ roster, viceId, stale, onUnmountWithFocus }: RosterListProps) {
  const i18n = useI18n();
  const { t, format, lang } = i18n;
  const headingId = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const onUnmount = useRef(onUnmountWithFocus);
  onUnmount.current = onUnmountWithFocus;
  useLayoutEffect(() => {
    const section = sectionRef.current;
    return () => {
      if (section?.contains(document.activeElement)) onUnmount.current?.();
    };
  }, []);

  const rows = orderRoster(roster);
  const counts = countRoster(roster);
  return (
    <section ref={sectionRef} aria-labelledby={headingId} className={styles.people}>
      <h3 id={headingId} tabIndex={-1} className={styles.peopleHeading}>
        <Template
          text={t.peopleHeadingCount}
          values={{ n: <Num value={rows.length} lang={lang} /> }}
        />
      </h3>
      {rows.length === 0 ? (
        <p className={styles.qrState} role="status">
          <span className={styles.spinner} aria-hidden="true" />
          {t.peopleLoading}
        </p>
      ) : (
        <>
          <p className={styles.muted}>
            <CounterText counts={counts} />
          </p>
          {stale ? <p className={styles.muted}>{t.peopleStale}</p> : null}
          <ul className={styles.roster}>
            {rows.map((entry) => {
              const own = entry.role === 'leader';
              const name = rosterNameText(entry, t, format);
              const nameNode = (
                <span className={entry.generated ? styles.generatedName : undefined}>
                  <PlainText text={name} dir="auto" maxLength={32} />
                </span>
              );
              return (
                <li key={entry.participantId} className={styles.rosterRow}>
                  <span className={styles.rosterName}>
                    {own ? <Template text={t.ownRow} values={{ name: nameNode }} /> : nameNode}
                  </span>
                  <span className={styles.rosterDetails}>
                    {!entry.connected ? (
                      <span className={styles.awayDot} aria-hidden="true" />
                    ) : null}
                    {rowDetails(entry, viceId, t).join(' · ')}
                  </span>
                  {entry.admittedSinceRecovery === true ? (
                    <span className={styles.recoveryLine}>{t.recoveryMarker}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {rows.length === 1 ? <p className={styles.para}>{t.peopleEmpty}</p> : null}
        </>
      )}
    </section>
  );
}
