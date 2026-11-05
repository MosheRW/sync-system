import type { PublicConfig } from '../config/schema.js';
import { isContentId } from '../content/content-id.js';
import type { ContentSource } from '../content/loader.js';

export type Route =
  | { kind: 'reading'; source: ContentSource }
  | { kind: 'library' }
  | {
      kind: 'book-not-found';
      /** The `?book` value, only when it is a well-formed content ID (security C6). */
      contentId: string | null;
      libraryLink: boolean;
    }
  | { kind: 'no-book'; libraryLink: boolean }
  | { kind: 'invalid-link'; libraryLink: boolean };

export interface LocationLike {
  pathname: string;
  search: string;
}

export const LIBRARY_PATH = '/library';

/**
 * Decides what the page shows (architecture 5.4, AC24-AC29, AC37, AC40).
 * Pure; the first rule that applies wins:
 * 1. single-book: the configured book, whatever the path or query (AC29);
 * 2. `/library` with the library on: the library;
 * 3. more than one of `book`/`src` (or one repeated): invalid link (AC37);
 * 4. `book`: the bundled book, else "Book not found", in every mode (AC28);
 * 5. `src`: fetched content (the src policy runs in the loader);
 * 6. no parameter: library / no-book / default book, per the entry mode (AC27, AC40).
 */
export function resolveEntry(
  config: PublicConfig,
  location: LocationLike,
  libraryIds: readonly string[],
): Route {
  const libraryLink = config.library === 'on' && config.entry !== 'single-book';

  if (config.entry === 'single-book' && config.book !== null) {
    return { kind: 'reading', source: { kind: 'bundled', contentId: config.book } };
  }
  if (location.pathname === LIBRARY_PATH && libraryLink) return { kind: 'library' };

  const params = new URLSearchParams(location.search);
  const books = params.getAll('book');
  const srcs = params.getAll('src');
  if (books.length + srcs.length > 1) return { kind: 'invalid-link', libraryLink };

  const book = books[0];
  if (book !== undefined) {
    if (isContentId(book) && libraryIds.includes(book)) {
      return { kind: 'reading', source: { kind: 'bundled', contentId: book } };
    }
    return { kind: 'book-not-found', contentId: isContentId(book) ? book : null, libraryLink };
  }

  const src = srcs[0];
  if (src !== undefined) return { kind: 'reading', source: { kind: 'url', url: src } };

  switch (config.entry) {
    case 'library':
      return libraryLink ? { kind: 'library' } : { kind: 'no-book', libraryLink };
    case 'default-book':
      return config.book !== null
        ? { kind: 'reading', source: { kind: 'bundled', contentId: config.book } }
        : { kind: 'no-book', libraryLink };
    default:
      return { kind: 'no-book', libraryLink };
  }
}
