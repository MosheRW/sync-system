import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { LoadedContent } from '../content/loader.js';
import { documentDir } from '../direction/effective.js';
import { useI18n } from '../i18n/index.js';
import { type MoveSource, usePageNavigation } from '../navigation/use-page-navigation.js';
import { PageView } from './ContentBlock.js';
import { LiveAnnouncer } from './LiveAnnouncer.js';
import { PageNav } from './PageNav.js';
import { ReaderHeader } from './ReaderHeader.js';
import styles from './ReadingScreen.module.css';

export interface ReadingScreenProps {
  content: LoadedContent;
  /** Move focus to the article on mount (after a successful retry). */
  focusContent?: boolean;
  /** The first page shown, e.g. restored from this tab's storage (#24 AC36). */
  initialIndex?: number;
  /** Every page change, with who caused it (the reader or the app). */
  onPageChange?: (index: number, source: MoveSource) => void;
  /** Reserved for item 8: header end slot and overlay layer. */
  headerEndSlot?: ReactNode;
  overlay?: ReactNode;
}

/**
 * One book, as if it were the only one (AC24): header, the content article
 * in the document's own direction and language, mirrored page navigation
 * and a live region. There is no link of any kind on this screen (AC36).
 */
export function ReadingScreen({
  content,
  focusContent = false,
  initialIndex = 0,
  onPageChange,
  headerEndSlot,
  overlay,
}: ReadingScreenProps) {
  const { t, format } = useI18n();
  const { document: doc } = content;
  const docDir = documentDir(doc);
  const total = doc.pages.length;
  const articleRef = useRef<HTMLElement>(null);
  // Swipes count anywhere between the header and the nav bar, not only
  // over the text: short pages leave most of <main> empty (design.md 5).
  const contentRegionRef = useRef<HTMLElement>(null);
  const nav = usePageNavigation(total, docDir, contentRegionRef, {
    initialIndex,
    ...(onPageChange ? { onMove: onPageChange } : {}),
  });
  const [announcement, setAnnouncement] = useState('');
  const page = doc.pages[nav.index] ?? doc.pages[0]!;

  useEffect(() => {
    document.title = doc.title?.replace(/\s*[\r\n]+\s*/g, ' ') ?? t.readingFallbackName;
  }, [doc.title, t.readingFallbackName]);

  useEffect(() => {
    if (focusContent) articleRef.current?.focus();
  }, [focusContent]);

  useEffect(() => {
    if (nav.lastMove !== null) {
      setAnnouncement(format(t.pageAnnouncement, { n: nav.index + 1, total }));
    }
  }, [nav.index, nav.lastMove, total, format, t.pageAnnouncement]);

  // Slide in from the side the reader moved toward (design.md section 5):
  // "next" enters from the document's end side.
  const enterFrom =
    nav.lastMove === 'next'
      ? docDir === 'rtl'
        ? styles.fromLeft
        : styles.fromRight
      : nav.lastMove === 'previous'
        ? docDir === 'rtl'
          ? styles.fromRight
          : styles.fromLeft
        : '';
  const nudge =
    nav.endNudge === null
      ? ''
      : (nav.endNudge.side === 'end') === (docDir === 'ltr')
        ? styles.nudgeLeft
        : styles.nudgeRight;

  return (
    <div className={styles.screen}>
      <ReaderHeader
        title={doc.title}
        docDir={docDir}
        docLang={doc.lang}
        index={nav.index}
        total={total}
        endSlot={headerEndSlot}
      />
      <main ref={contentRegionRef} className={styles.main}>
        <article
          ref={articleRef}
          tabIndex={-1}
          className={styles.article}
          dir={docDir}
          lang={doc.lang}
          aria-label={doc.title?.replace(/\s*[\r\n]+\s*/g, ' ') ?? t.readingFallbackName}
        >
          <div
            key={`${nav.index}-${nav.endNudge?.count ?? 0}`}
            className={`${styles.pageFrame} ${enterFrom} ${nudge}`}
          >
            <PageView doc={doc} page={page} />
          </div>
        </article>
        <div className={styles.overlay}>{overlay}</div>
      </main>
      <PageNav docDir={docDir} index={nav.index} total={total} onAction={nav.perform} />
      <LiveAnnouncer message={announcement} />
    </div>
  );
}
