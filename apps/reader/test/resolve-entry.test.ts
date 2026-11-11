import { describe, expect, it } from 'vitest';
import { type Route, resolveEntry } from '../src/app/resolve-entry.js';
import type { EntryMode, LibrarySetting, PublicConfig } from '../src/config/schema.js';

const IDS = ['samples/psalms-he', 'samples/untitled'];
const DEFAULT_BOOK = 'samples/untitled';

function config(entry: EntryMode, library: LibrarySetting): PublicConfig {
  return {
    entry,
    book: entry === 'default-book' || entry === 'single-book' ? DEFAULT_BOOK : null,
    library,
    uiLang: 'auto',
    srcOrigins: [],
    fetchTimeoutSeconds: 15,
    srcMaxBytes: 5_242_880,
    sync: null,
  };
}

const at = (c: PublicConfig, search = '', pathname = '/'): Route =>
  resolveEntry(c, { pathname, search }, IDS);

const bundled = (contentId: string): Route => ({
  kind: 'reading',
  source: { kind: 'bundled', contentId },
});

describe('resolveEntry: URL picks the content (AC25)', () => {
  const c = config('library', 'on');

  it('?book= opens a bundled book, encoded or not', () => {
    expect(at(c, '?book=samples/psalms-he')).toEqual(bundled('samples/psalms-he'));
    expect(at(c, '?book=samples%2Fpsalms-he')).toEqual(bundled('samples/psalms-he'));
  });

  it('?src= loads fetched content with the raw value', () => {
    expect(at(c, '?src=https%3A%2F%2Fa.example%2Fx.json')).toEqual({
      kind: 'reading',
      source: { kind: 'url', url: 'https://a.example/x.json' },
    });
    expect(at(c, '?src=')).toEqual({ kind: 'reading', source: { kind: 'url', url: '' } });
  });

  it.each([
    '?book=samples/psalms-he&src=https://a.example/x.json',
    '?src=https://a.example/x.json&book=samples/psalms-he',
    '?book=samples/psalms-he&book=samples/untitled',
    '?src=a&src=b',
    '?book=&src=',
  ])('%s is an invalid link (AC37)', (search) => {
    expect(at(c, search)).toEqual({ kind: 'invalid-link', libraryLink: true });
    expect(at(config('error', 'off'), search)).toEqual({
      kind: 'invalid-link',
      libraryLink: false,
    });
  });
});

describe('resolveEntry: no parameter (AC27, AC40)', () => {
  it('library mode shows the library', () => {
    expect(at(config('library', 'on'))).toEqual({ kind: 'library' });
  });

  it.each<LibrarySetting>(['on', 'off'])('error mode shows "no book" (library %s)', (library) => {
    expect(at(config('error', library))).toEqual({
      kind: 'no-book',
      libraryLink: library === 'on',
    });
  });

  it.each<LibrarySetting>(['on', 'off'])(
    'default-book mode opens the default (library %s)',
    (library) => {
      expect(at(config('default-book', library))).toEqual(bundled(DEFAULT_BOOK));
    },
  );

  it('serves /library only when the library is on', () => {
    expect(at(config('error', 'on'), '', '/library')).toEqual({ kind: 'library' });
    expect(at(config('default-book', 'on'), '', '/library')).toEqual({ kind: 'library' });
    expect(at(config('error', 'off'), '', '/library')).toEqual({
      kind: 'no-book',
      libraryLink: false,
    });
  });
});

describe('resolveEntry: unknown book (AC28)', () => {
  it.each<[EntryMode, LibrarySetting]>([
    ['library', 'on'],
    ['error', 'on'],
    ['error', 'off'],
    ['default-book', 'on'],
    ['default-book', 'off'],
  ])('mode %s, library %s: "Book not found", never the default book', (entry, library) => {
    expect(at(config(entry, library), '?book=acme/missing')).toEqual({
      kind: 'book-not-found',
      contentId: 'acme/missing',
      libraryLink: library === 'on',
    });
  });

  it.each(['', 'Not An ID', 'a'.repeat(300), '<script>', '../x'])(
    'a malformed ?book=%j is not echoed (security C6, F7)',
    (value) => {
      expect(at(config('library', 'on'), `?book=${encodeURIComponent(value)}`)).toEqual({
        kind: 'book-not-found',
        contentId: null,
        libraryLink: true,
      });
    },
  );
});

describe('resolveEntry: single-book mode (AC29)', () => {
  const c = config('single-book', 'off');

  it.each([
    ['', '/'],
    ['?book=samples/psalms-he', '/'],
    ['?book=acme/missing', '/'],
    ['?src=https://a.example/x.json', '/'],
    ['?book=samples/psalms-he&src=https://a.example/x.json', '/'],
    ['', '/library'],
  ])('ignores %j on %s', (search, pathname) => {
    expect(at(c, search, pathname)).toEqual(bundled(DEFAULT_BOOK));
  });
});
