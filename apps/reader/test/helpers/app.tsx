import { webcrypto } from 'node:crypto';
import { type RenderResult, render } from '@testing-library/react';
import { App } from '../../src/app/App.js';
import { type LocationLike, resolveEntry } from '../../src/app/resolve-entry.js';
import type { EntryMode, LibrarySetting, PublicConfig } from '../../src/config/schema.js';
import type { FetchLike } from '../../src/content/fetch-text.js';
import { type ContentLoader, createContentLoader } from '../../src/content/loader.js';
import type { StorageLike } from '../../src/group/session-store.js';
import type { UiLanguage } from '../../src/i18n/index.js';
import type { LibraryEntry } from '../../src/library/types.js';
import { sampleText } from './render.js';

export const ENTRIES: LibraryEntry[] = [
  { contentId: 'samples/psalms-he', title: 'תהילים: מזמורים נבחרים', lang: 'he', dir: 'rtl' },
  {
    contentId: 'samples/pride-and-prejudice-en',
    title: 'Pride and Prejudice (Chapter 1, opening)',
    lang: 'en',
    dir: 'ltr',
  },
  { contentId: 'samples/untitled', dir: 'ltr' },
];

export const BUNDLED: Record<string, () => Promise<string>> = {
  'samples/psalms-he': () => Promise.resolve(sampleText('psalms-he')),
  'samples/pride-and-prejudice-en': () => Promise.resolve(sampleText('pride-and-prejudice-en')),
  'samples/untitled': () => Promise.resolve(sampleText('untitled')),
};

export function testConfig(
  entry: EntryMode = 'library',
  library: LibrarySetting = 'on',
  overrides: Partial<PublicConfig> = {},
): PublicConfig {
  return {
    entry,
    book: entry === 'default-book' || entry === 'single-book' ? 'samples/untitled' : null,
    library,
    uiLang: 'auto',
    srcOrigins: ['https://content.example.org'],
    fetchTimeoutSeconds: 15,
    srcMaxBytes: 5_242_880,
    sync: null,
    ...overrides,
  };
}

export function testLoader(fetchImpl?: FetchLike, config = testConfig()): ContentLoader {
  return createContentLoader({
    bundled: BUNDLED,
    config,
    subtle: webcrypto.subtle,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
}

export function renderApp(options: {
  config?: PublicConfig | null;
  location?: Partial<LocationLike>;
  uiLang?: UiLanguage;
  fetchImpl?: FetchLike;
  loader?: ContentLoader;
  storage?: StorageLike | null;
}): RenderResult {
  const config = options.config === undefined ? testConfig() : options.config;
  const location = { pathname: '/', search: '', ...options.location };
  const route = config
    ? resolveEntry(
        config,
        location,
        ENTRIES.map((e) => e.contentId),
      )
    : null;
  const loader = options.loader ?? (config ? testLoader(options.fetchImpl, config) : null);
  return render(
    <App
      config={config}
      uiLang={options.uiLang ?? 'en'}
      route={route}
      entries={ENTRIES}
      loader={loader}
      storage={options.storage ?? null}
    />,
  );
}
