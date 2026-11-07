import { useMemo } from 'react';
import type { PublicConfig } from '../config/schema.js';
import type { ContentLoader, ContentSource } from '../content/loader.js';
import { LibraryScreen } from '../components/LibraryScreen.js';
import { ReadingScreen } from '../components/ReadingScreen.js';
import { LoadingScreen, StatusScreen } from '../components/StatusScreen.js';
import { type StatusInput, statusView } from '../components/status-screens.js';
import type { QrLanding } from '../group/deep-link.js';
import { type PageStore, type StorageLike, createPageStore } from '../group/session-store.js';
import { I18nProvider, type UiLanguage, useI18n } from '../i18n/index.js';
import type { LibraryEntry } from '../library/types.js';
import type { Route } from './resolve-entry.js';
import { useContent } from './use-content.js';

export interface AppProps {
  config: PublicConfig | null;
  /** Why `config` is `null` (#24 AC1): `sync` shows the sync settings details. */
  configIssue?: 'sync' | 'config' | null;
  uiLang: UiLanguage;
  route: Route | null;
  entries: readonly LibraryEntry[];
  loader: ContentLoader | null;
  /**
   * This tab's `sessionStorage`, already guarded (`safeSessionStorage()`),
   * for the reading position and the group pointer (ADR 0009). `null` or
   * absent: nothing is kept across reloads.
   */
  storage?: StorageLike | null;
  /**
   * A QR ticket this page load arrived with, already removed from the URL
   * (#24 R3). Memory only; ignored when sync is off.
   */
  qrLanding?: QrLanding | null;
}

function Status({ input, libraryOn }: { input: StatusInput; libraryOn: boolean }) {
  const i18n = useI18n();
  return <StatusScreen view={statusView(input, i18n, libraryOn)} />;
}

function ReadingRoute({
  loader,
  source,
  config,
  pages,
}: {
  loader: ContentLoader;
  source: ContentSource;
  config: PublicConfig;
  pages: PageStore;
}) {
  const i18n = useI18n();
  const { state, retry } = useContent(loader, source, config.fetchTimeoutSeconds);
  const libraryOn = config.library === 'on' && config.entry !== 'single-book';

  switch (state.status) {
    case 'loading':
      return state.showIndicator ? (
        <LoadingScreen stillLoading={state.stillLoading} />
      ) : (
        <main aria-busy="true" />
      );
    case 'error':
      return (
        <StatusScreen
          view={statusView({ kind: 'content-error', error: state.error }, i18n, libraryOn)}
          onRetry={retry}
          retrying={state.retrying}
        />
      );
    case 'ready': {
      // Nothing from a refused file ever reaches this point (AC3, AC4).
      const { metadata, document: doc } = state.content;
      return (
        <ReadingScreen
          content={state.content}
          focusContent={state.afterRetry}
          // This tab's page for this exact text (#24 AC36, Decision Q3).
          initialIndex={pages.read(metadata.contentId, metadata.fingerprint, doc.pages.length) ?? 0}
          onPageChange={(index) => pages.write(metadata.contentId, metadata.fingerprint, index)}
        />
      );
    }
  }
}

function Routes({
  config,
  configIssue,
  route,
  entries,
  loader,
  storage = null,
}: Omit<AppProps, 'uiLang'>) {
  const pages = useMemo(() => createPageStore(storage), [storage]);
  if (!config || !route || !loader) {
    return (
      <Status
        input={{ kind: 'not-configured', syncInvalid: configIssue === 'sync' }}
        libraryOn={false}
      />
    );
  }
  switch (route.kind) {
    case 'reading':
      return <ReadingRoute loader={loader} source={route.source} config={config} pages={pages} />;
    case 'library':
      return <LibraryScreen entries={entries} />;
    case 'book-not-found':
      return (
        <Status
          input={{ kind: 'book-not-found', contentId: route.contentId }}
          libraryOn={route.libraryLink}
        />
      );
    case 'no-book':
    case 'invalid-link':
      return <Status input={{ kind: route.kind }} libraryOn={route.libraryLink} />;
  }
}

/** The reading app: one route per page load (architecture P4). */
export function App({ uiLang, ...rest }: AppProps) {
  return (
    <I18nProvider lang={uiLang}>
      <Routes {...rest} />
    </I18nProvider>
  );
}
