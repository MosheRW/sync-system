import type { LeaderError } from '../../group/leader-errors.js';
import { useI18n } from '../../i18n/index.js';
import { Button } from './controls.js';
import styles from './group.module.css';
import { Num, Template } from './Template.js';

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={styles.previewIcon}>
      <path
        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

/**
 * The preview banner (#25 design 6.4, AC40): a mode banner in the banner
 * slot, not a live region; page numbers in their own isolates. Same page:
 * Return to group only; another page: Return to group and Bring group here.
 * Errors inline (`role="alert"`); the preview stays on.
 */
export function PreviewBanner({
  groupIndex,
  viewIndex,
  error,
  onReturn,
  onBring,
}: {
  /** The group's page (0-based), or `null` before the first position. */
  groupIndex: number | null;
  /** The page the leader views (0-based). */
  viewIndex: number;
  error: LeaderError | null;
  onReturn: () => void;
  onBring: () => void;
}) {
  const { t, lang } = useI18n();
  const same = groupIndex === null || groupIndex === viewIndex;
  const page = (index: number) => <Num value={index + 1} lang={lang} />;
  return (
    <div role="region" aria-label={t.previewRegion} className={styles.previewBanner}>
      <EyeIcon />
      <div className={styles.previewBody}>
        <p className={styles.para}>
          {same ? (
            <Template text={t.previewSamePage} values={{ n: page(groupIndex ?? viewIndex) }} />
          ) : (
            <Template
              text={t.previewPositions}
              values={{ group: page(groupIndex), view: page(viewIndex) }}
            />
          )}
        </p>
        <div className={styles.previewActions}>
          <Button onClick={onReturn}>{t.returnToGroup}</Button>
          {same ? null : (
            <Button variant="primary" onClick={onBring}>
              {t.bringGroupHere}
            </Button>
          )}
        </div>
        {error !== null ? (
          <p role="alert" className={styles.formError}>
            {t[error.key]}
          </p>
        ) : null}
      </div>
    </div>
  );
}
