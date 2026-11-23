import type { PastedLinkSignal } from '../../src/group/pasted-link.js';
import { webcrypto } from 'node:crypto';
import type { SyncClientLike } from '@mosherw/sync-system-react';
import { type RenderResult, act, render, screen } from '@testing-library/react';
import { App } from '../../src/app/App.js';
import { type LocationLike, resolveEntry } from '../../src/app/resolve-entry.js';
import type {
  EntryMode,
  LibrarySetting,
  PublicConfig,
  SyncConfig,
} from '../../src/config/schema.js';
import type { FetchLike } from '../../src/content/fetch-text.js';
import { type ContentLoader, createContentLoader } from '../../src/content/loader.js';
import type { QrLanding } from '../../src/group/deep-link.js';
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

/** Sync on, against a loopback test server (#24). */
export const SYNC: SyncConfig = Object.freeze({
  url: 'ws://127.0.0.1:8080/ws',
  apiKey: 'dev-only-insecure-api-key-change-me-please',
  appVersion: '0.1.0',
  lateJoinSeconds: 10,
});

/** The pointer key for SYNC's host. */
export const POINTER_KEY = 'reader:v1:group@127.0.0.1:8080';

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

/**
 * Waits until the reading screen shows `counter` and React has run its
 * effects. `findBy*` resolves on the DOM mutation, which can come before the
 * passive effects that attach the page-turn key listener; a key pressed in
 * between is lost.
 */
export async function readingReady(counter: RegExp = /^\d+ \/ \d+$/): Promise<HTMLElement> {
  const element = await screen.findByText(counter);
  await act(async () => {
    await Promise.resolve();
  });
  return element;
}

export function renderApp(options: {
  config?: PublicConfig | null;
  location?: Partial<LocationLike>;
  uiLang?: UiLanguage;
  fetchImpl?: FetchLike;
  loader?: ContentLoader;
  storage?: StorageLike | null;
  qrLanding?: QrLanding | null;
  syncClient?: SyncClientLike;
  pastedLinks?: PastedLinkSignal;
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
      qrLanding={options.qrLanding ?? null}
      {...(options.syncClient ? { syncClient: options.syncClient } : {})}
      {...(options.pastedLinks ? { pastedLinks: options.pastedLinks } : {})}
    />,
  );
}
