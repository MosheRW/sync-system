import { useEffect, useMemo } from 'react';
import { languageName, useI18n } from '../i18n/index.js';
import type { LibraryEntry } from '../library/types.js';
import styles from './LibraryScreen.module.css';
import { PlainText } from './PlainText.js';

/** Link to a book's own reading page; IDs come from the validated build index (C6). */
export function bookHref(contentId: string): string {
  return `/?book=${encodeURIComponent(contentId)}`;
}

function Chevron({ uiDir }: { uiDir: 'ltr' | 'rtl' }) {
  return (
    <svg className={styles.chevron} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d={uiDir === 'rtl' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** One row: the whole row is a link; the title keeps its own book's direction (design.md 8a). */
export function LibraryItem({ entry }: { entry: LibraryEntry }) {
  const { lang: uiLang, dir: uiDir } = useI18n();
  const title =
    entry.title !== undefined ? (
      <PlainText
        text={entry.title}
        dir={entry.dir}
        {...(entry.lang ? { lang: entry.lang } : {})}
        singleLine
      />
    ) : (
      <PlainText text={entry.contentId} dir="ltr" />
    );
  return (
    <li className={styles.item}>
      <a className={styles.row} href={bookHref(entry.contentId)}>
        <span className={styles.text}>
          <span
            className={entry.title !== undefined ? styles.title : `${styles.title} ${styles.id}`}
          >
            {title}
          </span>
          {entry.lang ? (
            <span className={styles.language}>{languageName(uiLang, entry.lang)}</span>
          ) : null}
        </span>
        <Chevron uiDir={uiDir} />
      </a>
    </li>
  );
}

/**
 * The library (AC26, AC39): every bundled book that passed validation,
 * sorted by title (content ID when untitled) in the interface locale.
 */
export function LibraryScreen({ entries }: { entries: readonly LibraryEntry[] }) {
  const { t, lang } = useI18n();
  const sorted = useMemo(() => {
    const collator = new Intl.Collator(lang);
    return [...entries].sort((a, b) =>
      collator.compare(a.title ?? a.contentId, b.title ?? b.contentId),
    );
  }, [entries, lang]);

  useEffect(() => {
    document.title = t.libraryHeading;
  }, [t.libraryHeading]);

  return (
    <div className={styles.screen}>
      <main className={styles.main}>
        {/* The heading bar sits inside <main> (design.md 9: <main> holds the one <h1>). */}
        <div className={styles.header}>
          <h1 className={styles.heading} tabIndex={-1}>
            {t.libraryHeading}
          </h1>
        </div>
        <ul className={styles.list}>
          {sorted.map((entry) => (
            <LibraryItem key={entry.contentId} entry={entry} />
          ))}
        </ul>
      </main>
    </div>
  );
}
