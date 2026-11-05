import type { PublicConfig } from '../config/schema.js';
import type { ContentLoader, ContentSource } from '../content/loader.js';
import { LibraryScreen } from '../components/LibraryScreen.js';
import { ReadingScreen } from '../components/ReadingScreen.js';
import { LoadingScreen, StatusScreen } from '../components/StatusScreen.js';
import { type StatusInput, statusView } from '../components/status-screens.js';
import { I18nProvider, type UiLanguage, useI18n } from '../i18n/index.js';
import type { LibraryEntry } from '../library/types.js';
import type { Route } from './resolve-entry.js';
import { useContent } from './use-content.js';

export interface AppProps {
  config: PublicConfig | null;
  uiLang: UiLanguage;
  route: Route | null;
  entries: readonly LibraryEntry[];
  loader: ContentLoader | null;
}

function Status({ input, libraryOn }: { input: StatusInput; libraryOn: boolean }) {
  const i18n = useI18n();
  return <StatusScreen view={statusView(input, i18n, libraryOn)} />;
}

function ReadingRoute({
  loader,
  source,
  config,
}: {
  loader: ContentLoader;
  source: ContentSource;
  config: PublicConfig;
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
    case 'ready':
      // Nothing from a refused file ever reaches this point (AC3, AC4).
      return <ReadingScreen content={state.content} focusContent={state.afterRetry} />;
  }
}

function Routes({ config, route, entries, loader }: Omit<AppProps, 'uiLang'>) {
  if (!config || !route || !loader) {
    return <Status input={{ kind: 'not-configured' }} libraryOn={false} />;
  }
  switch (route.kind) {
    case 'reading':
      return <ReadingRoute loader={loader} source={route.source} config={config} />;
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
