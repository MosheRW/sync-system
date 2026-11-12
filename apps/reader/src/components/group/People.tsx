import { type RosterEntry, useMemberRemoval, useViceLeader } from '@sync-system/react';
import { type Ref, forwardRef, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { leaderActionError } from '../../group/leader-errors.js';
import { isolateName, rosterNameText } from '../../group/names.js';
import {
  countRoster,
  counterKey,
  orderRoster,
  rowDetails,
  type RosterCounts,
} from '../../group/roster-view.js';
import { useActionError } from '../../group/use-retry-wait.js';
import { type I18n, useI18n } from '../../i18n/index.js';
import { PlainText } from '../PlainText.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { ActionErrorLine, Button } from './controls.js';
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
  /** Polite announcements (vice, removed). */
  announce: (text: string) => void;
  /** A leader action succeeded (the last-chance hint goes, #25 8.3). */
  onActivity?: () => void;
  /** Focus was inside the list when it unmounted (resize below 1024 px, design F14.4). */
  onUnmountWithFocus?: () => void;
}

type RowAction = 'setVice' | 'clearVice';

/** Where focus goes when the row `id` goes: next row, else previous, else the heading. */
function neighbour(order: readonly string[], id: string): string | null {
  const index = order.indexOf(id);
  if (index < 0) return null;
  return order[index + 1] ?? order[index - 1] ?? null;
}

function Chevron() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={styles.rowChevron}>
      <path
        d="M6 9l6 6 6-6"
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
 * The people in the group (#25 design 6.2, AC38, AC39, AC61) with the
 * leader's row actions (AC42, AC43): the own row first, then the roster's
 * own order. Names are text through `PlainText` (#24 R7, #25 R15); element
 * IDs come from `useId()` plus the row index, never from a participant ID
 * or a name (L5); participant IDs only key rows and JS maps, and every
 * action takes the ID from the current roster entry (R16).
 */
export function RosterList({
  roster,
  viceId,
  stale,
  announce,
  onActivity,
  onUnmountWithFocus,
}: RosterListProps) {
  const i18n = useI18n();
  const { t, format, lang } = i18n;
  const baseId = useId();
  const headingId = `${baseId}-h`;
  const sectionRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const onUnmount = useRef(onUnmountWithFocus);
  onUnmount.current = onUnmountWithFocus;
  useLayoutEffect(() => {
    const section = sectionRef.current;
    return () => {
      if (section?.contains(document.activeElement)) onUnmount.current?.();
    };
  }, []);

  const vice = useViceLeader();
  const removal = useMemberRemoval();
  const [open, setOpen] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; action: RowAction } | null>(null);
  const rowError = useActionError();
  const [rowErrorFor, setRowErrorFor] = useState<string | null>(null);
  const removeError = useActionError();
  const listError = useActionError();
  const [removeTarget, setRemoveTarget] = useState<{
    id: string;
    name: string;
    details: string;
  } | null>(null);
  const toggles = useRef(new Map<string, HTMLButtonElement>());
  // Where focus goes next: a row toggle by participant ID, or the heading (`id: null`).
  const focusAfter = useRef<{ readonly id: string | null } | null>(null);
  const focusedRow = useRef<string | null>(null);

  const rows = orderRoster(roster);
  const counts = countRoster(roster);
  const order = rows.filter((entry) => entry.role !== 'leader').map((e) => e.participantId);
  const previousOrder = useRef(order);

  // A row that goes closes its action area and its remove dialog (design 6.2,
  // F17); focus inside a row that went moves to a neighbour.
  const removing = removal.remove.pending;
  useLayoutEffect(() => {
    const before = previousOrder.current;
    previousOrder.current = order;
    if (open !== null && !order.includes(open)) setOpen(null);
    if (removeTarget !== null && !order.includes(removeTarget.id) && !removing) {
      setRemoveTarget(null);
      listError.set({ key: 'errPersonGone', withName: true }, removeTarget.name);
      focusAfter.current = { id: neighbour(before, removeTarget.id) };
    }
    const gone = focusedRow.current;
    if (gone !== null && !order.includes(gone)) {
      focusedRow.current = null;
      if (document.activeElement === null || document.activeElement === document.body) {
        focusAfter.current = { id: neighbour(before, gone) };
      }
    }
  });
  useEffect(() => {
    const target = focusAfter.current;
    // Wait until the remove dialog is gone (its background is inert).
    if (target === null || removeTarget !== null) return;
    focusAfter.current = null;
    (target.id === null ? headingRef.current : toggles.current.get(target.id))?.focus();
  });

  const runVice = (entry: RosterEntry, name: string, action: RowAction) => {
    const id = entry.participantId;
    setPending({ id, action });
    rowError.clear();
    setRowErrorFor(null);
    const running = action === 'setVice' ? vice.setVice.run(id) : vice.clearVice.run();
    void running.then((result) => {
      setPending(null);
      if (result.ok) {
        onActivity?.();
        setOpen(null);
        toggles.current.get(id)?.focus();
        announce(
          action === 'setVice'
            ? format(t.announceVice, { name: isolateName(name) })
            : t.announceViceCleared,
        );
        return;
      }
      rowError.set(leaderActionError(action, result.error), name);
      setRowErrorFor(id);
    });
  };

  const runRemove = () => {
    if (removeTarget === null) return;
    const { id, name } = removeTarget;
    removeError.clear();
    void removal.remove.run(id).then((result) => {
      if (result.ok) {
        onActivity?.();
        focusAfter.current = { id: neighbour(previousOrder.current, id) };
        setRemoveTarget(null);
        setOpen(null);
        announce(format(t.announceRemoved, { name: isolateName(name) }));
        return;
      }
      const error = leaderActionError('remove', result.error);
      if (error?.aboveList === true) {
        setRemoveTarget(null);
        listError.set(error, name);
        return;
      }
      removeError.set(error, name);
    });
  };

  return (
    <section ref={sectionRef} aria-labelledby={headingId} className={styles.people}>
      <h3 ref={headingRef} id={headingId} tabIndex={-1} className={styles.peopleHeading}>
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
          <ActionErrorLine state={listError} />
          <ul className={styles.roster}>
            {rows.map((entry, index) => {
              const id = entry.participantId;
              const own = entry.role === 'leader';
              const name = rosterNameText(entry, t, format);
              const details = rowDetails(entry, viceId, t).join(' · ');
              const nameNode = (
                <span className={entry.generated ? styles.generatedName : undefined}>
                  <PlainText text={name} dir="auto" maxLength={32} />
                </span>
              );
              const nameId = `${baseId}-${index}-name`;
              const detailsId = `${baseId}-${index}-details`;
              const areaId = `${baseId}-${index}-actions`;
              const hintId = `${baseId}-${index}-hint`;
              const line2 = (
                <span id={detailsId} className={styles.rosterDetails}>
                  {!entry.connected ? <span className={styles.awayDot} aria-hidden="true" /> : null}
                  {details}
                </span>
              );
              const marker =
                entry.admittedSinceRecovery === true ? (
                  <span className={styles.recoveryLine}>{t.recoveryMarker}</span>
                ) : null;
              if (own) {
                return (
                  <li key={id} className={styles.rosterRow}>
                    <span className={styles.rosterName}>
                      <Template text={t.ownRow} values={{ name: nameNode }} />
                    </span>
                    {line2}
                    {marker}
                  </li>
                );
              }
              const isOpen = open === id;
              const isVice = viceId === id;
              const busy = pending?.id === id;
              const waiting = rowErrorFor === id && rowError.waitLeft > 0;
              return (
                <li
                  key={id}
                  className={styles.rosterRow}
                  onFocus={() => {
                    focusedRow.current = id;
                  }}
                >
                  <button
                    ref={(element) => {
                      if (element !== null) toggles.current.set(id, element);
                      else toggles.current.delete(id);
                    }}
                    type="button"
                    className={styles.rowToggle}
                    aria-expanded={isOpen}
                    aria-controls={areaId}
                    aria-labelledby={`${nameId} ${detailsId}`}
                    onClick={() => setOpen(isOpen ? null : id)}
                  >
                    <span className={styles.rowToggleText}>
                      <span id={nameId} className={styles.rosterName}>
                        {nameNode}
                      </span>
                      {line2}
                      {marker}
                    </span>
                    <Chevron />
                  </button>
                  {isOpen ? (
                    <div id={areaId} className={styles.rowActions}>
                      {isVice ? (
                        <Button
                          pending={busy && pending.action === 'clearVice'}
                          pendingLabel={t.clearingVice}
                          inactive={busy || waiting}
                          onClick={() => runVice(entry, name, 'clearVice')}
                        >
                          {t.clearVice}
                        </Button>
                      ) : (
                        <>
                          <Button
                            pending={busy && pending.action === 'setVice'}
                            pendingLabel={t.settingVice}
                            inactive={!entry.connected || busy || waiting}
                            aria-describedby={hintId}
                            onClick={() => runVice(entry, name, 'setVice')}
                          >
                            {t.makeVice}
                          </Button>
                          <p id={hintId} className={styles.muted}>
                            {entry.connected ? t.makeViceHint : t.makeViceAway}
                          </p>
                        </>
                      )}
                      <Button
                        variant="danger"
                        inactive={busy}
                        onClick={() => {
                          removeError.clear();
                          listError.clear();
                          setRemoveTarget({ id, name, details });
                        }}
                      >
                        {t.removeMember}
                      </Button>
                      {rowErrorFor === id ? <ActionErrorLine state={rowError} /> : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {rows.length === 1 ? <p className={styles.para}>{t.peopleEmpty}</p> : null}
        </>
      )}
      {removeTarget !== null ? (
        <ConfirmDialog
          title={
            <Template
              text={t.removeTitle}
              values={{ name: <PlainText text={removeTarget.name} dir="auto" maxLength={32} /> }}
            />
          }
          detail={removeTarget.details}
          body={t.removeBody}
          confirmLabel={t.removeConfirm}
          pendingLabel={t.removing}
          tone="danger"
          pending={removal.remove.pending}
          confirmInactive={removeError.waitLeft > 0}
          error={<ActionErrorLine state={removeError} />}
          onConfirm={runRemove}
          onCancel={() => setRemoveTarget(null)}
        />
      ) : null}
    </section>
  );
}
