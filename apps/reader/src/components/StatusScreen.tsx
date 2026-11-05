import { type ReactNode, useEffect, useRef } from 'react';
import { useI18n } from '../i18n/index.js';
import styles from './StatusScreen.module.css';

export const LIBRARY_HREF = '/library';

export interface StatusView {
  heading: string;
  body?: string;
  tone: 'neutral' | 'danger';
  /** Fetch failures only: retrying can help (design.md section 8). */
  retry: boolean;
  /** `primary` "Go to library", `secondary` "Back to library", or none. */
  libraryLink: 'primary' | 'secondary' | null;
  /** Plain text only (external values through PlainText). */
  details?: ReactNode;
}

export interface StatusScreenProps {
  view: StatusView;
  onRetry?: () => void;
  retrying?: boolean;
}

function Icon({ tone }: { tone: StatusView['tone'] }) {
  return (
    <svg
      className={`${styles.icon} ${tone === 'danger' ? styles.danger : ''}`}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="16.5" r="1.25" fill="currentColor" />
    </svg>
  );
}

/**
 * Shared layout for errors, refusals and "nothing to show" (design.md 8):
 * interface direction only, never text from the file. Focus moves to the
 * heading on arrival so screen readers hear the reason; the page title is
 * the heading.
 */
export function StatusScreen({ view, onRetry, retrying = false }: StatusScreenProps) {
  const { t } = useI18n();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    document.title = view.heading;
    headingRef.current?.focus();
  }, [view.heading]);

  const libraryLabel = view.libraryLink === 'primary' ? t.goToLibrary : t.backToLibrary;
  const showRetry = view.retry && onRetry !== undefined;

  return (
    <main className={styles.screen}>
      <div className={styles.panel}>
        <Icon tone={view.tone} />
        <h1 ref={headingRef} tabIndex={-1} className={styles.heading}>
          {view.heading}
        </h1>
        {view.body ? <p className={styles.body}>{view.body}</p> : null}
        {showRetry || view.libraryLink ? (
          <div className={styles.actions}>
            {showRetry ? (
              <button
                type="button"
                className={styles.primary}
                aria-disabled={retrying ? 'true' : undefined}
                onClick={() => {
                  if (!retrying) onRetry();
                }}
              >
                {retrying ? <span className={styles.spinner} aria-hidden="true" /> : null}
                {retrying ? t.tryingAgain : t.tryAgain}
              </button>
            ) : null}
            {view.libraryLink ? (
              <a
                href={LIBRARY_HREF}
                className={
                  view.libraryLink === 'primary' && !showRetry ? styles.primary : styles.secondary
                }
              >
                {libraryLabel}
              </a>
            ) : null}
          </div>
        ) : null}
        {view.details ? (
          <details className={styles.details}>
            <summary>{t.details}</summary>
            <p className={styles.detailsText}>{view.details}</p>
          </details>
        ) : null}
      </div>
    </main>
  );
}

/** The loading state (design.md 8): spinner and text, "still loading" after 8 s. */
export function LoadingScreen({ stillLoading }: { stillLoading: boolean }) {
  const { t } = useI18n();
  return (
    <main className={styles.screen} aria-busy="true">
      <div className={styles.panel} role="status">
        <span className={styles.spinner} aria-hidden="true" />
        <p className={styles.heading}>{t.loading}</p>
        {stillLoading ? <p className={styles.body}>{t.stillLoading}</p> : null}
      </div>
    </main>
  );
}
