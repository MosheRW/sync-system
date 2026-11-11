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
  /** The Group button (#24 design 5.1). */
  headerEndSlot?: ReactNode;
  /** Docked prompts and the approval tray, after the article (design 4.1, 6.13-6.15). */
  overlay?: ReactNode;
  /** Inside the sticky header, under its row: the leader's code strip (design 4.2). */
  belowHeader?: ReactNode;
  /**
   * The banner slot (#25 design 2.1, D1): one banner, sticky at the top of
   * the reading column under the header, before `notices`.
   */
  banner?: ReactNode;
  /** At the top of the reading region: the leader's codes notices (design 6.6). */
  notices?: ReactNode;
  /** The leader's Group panel column at 1024 px and up (design 4.3). */
  aside?: ReactNode;
  /** Replaces the article; header and page navigation are hidden (mismatch block, 6.11). */
  blocked?: ReactNode;
  /** A group announcement for the shared live region (design 9); a page announcement wins. */
  announce?: { readonly text: string; readonly id: number } | null;
  /** The assertive channel (#25 D4): keep-alive appearance and run-out only. */
  announceAssertive?: { readonly text: string; readonly id: number } | null;
  /** The app moves the page (a group move): `goTo(index, 'app')` once per `id`. */
  jumpRequest?: { readonly index: number; readonly id: number } | null;
}

/** The article's ID, so group prompts can return focus to it (design 9). */
export const ARTICLE_ID = 'reader-article';

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
  belowHeader,
  banner,
  notices,
  aside,
  blocked,
  announce = null,
  announceAssertive = null,
  jumpRequest = null,
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
    swipeKey: blocked !== undefined && blocked !== null,
  });
  const [announcement, setAnnouncement] = useState('');
  const [assertive, setAssertive] = useState('');
  const page = doc.pages[nav.index] ?? doc.pages[0]!;
  const screenRef = useRef<HTMLDivElement>(null);

  // The banner sticks under the sticky header, whose height changes with the
  // code strip: the height goes to a custom property through the CSSOM (no
  // `style=` attribute, #24 R12).
  const hasBanner = banner !== undefined && banner !== null;
  useEffect(() => {
    const screen = screenRef.current;
    const header = screen?.querySelector('header');
    if (!hasBanner || !screen || !header || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      screen.style.setProperty('--header-block-size', `${header.getBoundingClientRect().height}px`);
    });
    observer.observe(header);
    return () => observer.disconnect();
  }, [hasBanner]);

  useEffect(() => {
    document.title = doc.title?.replace(/\s*[\r\n]+\s*/g, ' ') ?? t.readingFallbackName;
  }, [doc.title, t.readingFallbackName]);

  useEffect(() => {
    if (focusContent) articleRef.current?.focus();
  }, [focusContent]);

  const pageAnnouncedAt = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    if (nav.lastMove !== null) {
      pageAnnouncedAt.current = Date.now();
      setAnnouncement(format(t.pageAnnouncement, { n: nav.index + 1, total }));
    }
  }, [nav.index, nav.lastMove, total, format, t.pageAnnouncement]);

  // One polite region for pages and group messages; a group message that
  // arrives with a page turn doesn't replace "Page n of N" (design 9).
  useEffect(() => {
    if (announce === null) return;
    if (Date.now() - pageAnnouncedAt.current < 100) return;
    setAnnouncement(announce.text);
  }, [announce]);

  useEffect(() => {
    if (announceAssertive !== null) setAssertive(announceAssertive.text);
  }, [announceAssertive]);

  const bannerSlot = hasBanner ? <div className={styles.banner}>{banner}</div> : null;

  const { goTo } = nav;
  useEffect(() => {
    if (jumpRequest !== null) goTo(jumpRequest.index, 'app');
  }, [jumpRequest, goTo]);

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

  if (blocked !== undefined && blocked !== null) {
    // Nothing to navigate while blocked: no header, no page navigation (6.11).
    return (
      <div ref={screenRef} className={styles.screen}>
        <main ref={contentRegionRef} className={styles.main}>
          {bannerSlot}
          {notices}
          {blocked}
        </main>
        <LiveAnnouncer message={announcement} assertive={assertive} />
      </div>
    );
  }

  const column = (
    <>
      <main ref={contentRegionRef} className={styles.main}>
        {bannerSlot}
        {notices}
        <article
          ref={articleRef}
          id={ARTICLE_ID}
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
    </>
  );

  return (
    <div ref={screenRef} className={styles.screen}>
      <ReaderHeader
        title={doc.title}
        docDir={docDir}
        docLang={doc.lang}
        index={nav.index}
        total={total}
        endSlot={headerEndSlot}
        below={belowHeader}
      />
      {aside !== undefined && aside !== null ? (
        <div className={styles.withPanel}>
          <div className={styles.column}>{column}</div>
          {aside}
        </div>
      ) : (
        column
      )}
      <LiveAnnouncer message={announcement} assertive={assertive} />
    </div>
  );
}
