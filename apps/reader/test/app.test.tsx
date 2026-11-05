import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntryMode, LibrarySetting } from '../src/config/schema.js';
import type { FetchLike } from '../src/content/fetch-text.js';
import type { ContentLoader, LoadResult } from '../src/content/loader.js';
import { renderApp, testConfig } from './helpers/app.js';
import { sampleText } from './helpers/render.js';

const SRC = '?src=https%3A%2F%2Fcontent.example.org%2Fbook.json';

afterEach(() => {
  vi.useRealTimers();
});

const heading1 = async () => (await screen.findByRole('heading', { level: 1 })).textContent;

describe('app routing (AC25-AC29, AC37, AC40)', () => {
  it('shows the library for the library entry', async () => {
    renderApp({});
    expect(await heading1()).toBe('Library');
  });

  it('opens a bundled book with ?book=', async () => {
    renderApp({ location: { search: '?book=samples/psalms-he' } });
    expect((await screen.findByRole('article')).getAttribute('dir')).toBe('rtl');
  });

  it('opens fetched content with ?src= through the same loader', async () => {
    const fetchImpl: FetchLike = () =>
      Promise.resolve(new Response(sampleText('pride-and-prejudice-en')));
    renderApp({ location: { search: SRC }, fetchImpl });
    expect((await screen.findByRole('article')).getAttribute('lang')).toBe('en');
  });

  it('shows an invalid-link screen for ?book and ?src together and loads neither (AC37)', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    renderApp({ location: { search: `${SRC}&book=samples/psalms-he` }, fetchImpl });
    expect(await heading1()).toBe("This link isn't valid");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it.each<[EntryMode, LibrarySetting]>([
    ['library', 'on'],
    ['error', 'on'],
    ['error', 'off'],
    ['default-book', 'on'],
    ['default-book', 'off'],
  ])('unknown book in %s mode, library %s: Book not found (AC28)', async (entry, library) => {
    renderApp({ config: testConfig(entry, library), location: { search: '?book=acme/missing' } });
    expect(await heading1()).toBe('Book not found');
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Go to library' }) !== null).toBe(library === 'on');
  });

  it.each<[EntryMode, LibrarySetting, string]>([
    ['library', 'on', 'Library'],
    ['error', 'on', 'No book selected'],
    ['error', 'off', 'No book selected'],
  ])('no parameter in %s mode (library %s) shows %s (AC27, AC40)', async (entry, library, text) => {
    renderApp({ config: testConfig(entry, library) });
    expect(await heading1()).toBe(text);
  });

  it('no parameter in default-book mode opens the default book, never the library', async () => {
    renderApp({ config: testConfig('default-book', 'on') });
    expect(await screen.findByRole('article')).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Library' })).toBeNull();
  });

  it('single-book mode ignores ?book, ?src and /library (AC29)', async () => {
    for (const location of [
      { search: '?book=samples/psalms-he' },
      { search: SRC },
      { search: `${SRC}&book=x/y` },
      { pathname: '/library' },
    ]) {
      const { unmount } = renderApp({ config: testConfig('single-book', 'off'), location });
      const article = await screen.findByRole('article');
      expect(article.getAttribute('aria-label')).toBe('Reading');
      expect(screen.queryByRole('link')).toBeNull();
      unmount();
    }
  });

  it('shows "app isn\'t set up" without a valid config (C5)', async () => {
    renderApp({ config: null });
    expect(await heading1()).toBe("This app isn't set up");
  });
});

describe('refused files render nothing from the file (AC3, AC4, AC16, AC31)', () => {
  const v2 = JSON.stringify({
    schemaVersion: 2,
    contentId: 'evil/title',
    title: 'SHOULD NOT RENDER',
    pages: [{ blocks: [{ text: 'SHOULD NOT RENDER' }] }],
  });
  const broken = JSON.stringify({
    schemaVersion: 1,
    contentId: 'evil/title',
    title: 'SHOULD NOT RENDER',
    pages: [{ blocks: [{ text: 'SHOULD NOT RENDER' }] }, { blocks: [] }],
  });

  it.each([
    ['too new', v2, 'This text needs a newer app'],
    ['invalid', broken, "This file can't be opened"],
    ['not JSON', '<html>', "This file can't be opened"],
  ])('%s: blocked screen with Back to library', async (_name, body, heading) => {
    const fetchImpl: FetchLike = () => Promise.resolve(new Response(body));
    const { container } = renderApp({ location: { search: SRC }, fetchImpl });
    expect(await heading1()).toBe(heading);
    expect(container.textContent).not.toContain('SHOULD NOT RENDER');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to library' })).toBeDefined();
  });

  it('no Back to library when the library is off', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(new Response(v2));
    renderApp({ config: testConfig('error', 'off'), location: { search: SRC }, fetchImpl });
    expect(await heading1()).toBe('This text needs a newer app');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('src not allowed shows the origin as text and fetches nothing', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    const { container } = renderApp({
      location: { search: '?src=https%3A%2F%2Fevil.example%2Fx.json' },
      fetchImpl,
    });
    expect(await heading1()).toBe("This text can't be opened here");
    expect(container.querySelector('details')!.textContent).toContain('https://evil.example');
    expect(container.querySelector('a[href*="evil"]')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('fetch failures and retry (AC5, AC31, AC34)', () => {
  it('Try again re-runs the load and focuses the content on success', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls++;
      return calls === 1
        ? Promise.reject(new TypeError('offline'))
        : Promise.resolve(new Response(sampleText('pride-and-prejudice-en')));
    };
    renderApp({ location: { search: SRC }, fetchImpl });
    expect(await heading1()).toBe("Can't load this text");
    expect(screen.getByRole('link', { name: 'Back to library' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    const article = await screen.findByRole('article');
    expect(calls).toBe(2);
    await waitFor(() => expect(document.activeElement).toBe(article));
  });

  it('shows only Try again when the library is off', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(new Response('', { status: 500 }));
    renderApp({ config: testConfig('error', 'off'), location: { search: SRC }, fetchImpl });
    expect(await heading1()).toBe("Can't load this text");
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows the loading indicator only after 300 ms and "still loading" after 8 s', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let resolve!: (result: LoadResult) => void;
    const loader: ContentLoader = {
      load: () => new Promise((r) => (resolve = r)),
      capabilities: { versionLookup: false },
    };
    renderApp({ location: { search: SRC }, loader });
    expect(screen.queryByText('Loading…')).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(screen.getByText('Loading…')).toBeDefined();
    expect(screen.queryByText(/Still loading/)).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(7700));
    expect(screen.getByText(/Still loading/)).toBeDefined();
    await act(async () => {
      resolve({ ok: false, error: { kind: 'timeout', seconds: 15 } });
      await Promise.resolve();
    });
    expect(screen.getByText('Loading took too long')).toBeDefined();
  });
});
