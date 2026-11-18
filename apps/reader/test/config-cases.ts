/**
 * Invalid-config case tables of the reader (#36 AC39). Used by
 * `config-matrix.node.test.ts` (every case through `run()`) and by
 * `startup-errors-doc.node.test.ts` (every printed line must be listed in
 * docs/startup-errors.md). All values are test-only, never real.
 */
import type { KNOWN_READER_VARIABLES } from '../src/config/known-vars.js';

/** A valid sync API key: it must never be printed. */
export const API_KEY = 'SENTINEL-READER-KEY-0123456789-0123456789';
export const SYNC_URL = 'wss://sync.example.org/ws';

/** The library of the default test dist. */
export const LIBRARY_IDS: readonly string[] = ['samples/psalms-he', 'samples/untitled'];

export const GLOBAL_SENTINELS: readonly string[] = [API_KEY];

export interface ReaderCase {
  id: string;
  /** The variable the case targets. */
  target: (typeof KNOWN_READER_VARIABLES)[number] | 'PORT' | 'unknown';
  env: Record<string, string>;
  /** The bundled library; defaults to LIBRARY_IDS. */
  ids?: readonly string[];
  /** Text that must not appear in stderr. */
  sentinels: string[];
  /** The exact problem lines, without the `Config error: ` prefix. */
  problems: string[];
}

const LONG = 'SENTINEL-long-value-0123456789-0123456789-0123456789';
/** The reader's truncated echo of LONG: 40 characters and an ellipsis (Q24). */
const LONG_SHOWN = `"${Array.from(LONG).slice(0, 40).join('')}…"`;
const ORIGIN_CREDENTIALS = 'must not contain a user name or password';
const HINT = 'remove it or fix the name (see "Configuration" in apps/reader/README.md)';

export const READER_CASES: readonly ReaderCase[] = [
  {
    id: 'READER_ENTRY unknown, truncated echo',
    target: 'READER_ENTRY',
    env: { READER_ENTRY: LONG },
    sentinels: [LONG],
    problems: [
      `READER_ENTRY ${LONG_SHOWN} must be one of: library, error, default-book, single-book`,
    ],
  },
  {
    id: 'READER_BOOK required',
    target: 'READER_BOOK',
    env: { READER_ENTRY: 'default-book' },
    sentinels: [],
    problems: ['READER_BOOK is required when READER_ENTRY is default-book'],
  },
  {
    id: 'READER_BOOK not opened',
    target: 'READER_BOOK',
    env: { READER_BOOK: 'samples/untitled' },
    sentinels: [],
    problems: [
      'READER_BOOK is set but READER_ENTRY is library, which never opens it (use default-book or single-book, or unset READER_BOOK)',
    ],
  },
  {
    id: 'READER_BOOK not a content ID',
    target: 'READER_BOOK',
    env: { READER_ENTRY: 'default-book', READER_BOOK: 'not an id' },
    sentinels: [],
    problems: ['READER_BOOK "not an id" is not a content ID (namespace/slug)'],
  },
  {
    id: 'READER_BOOK not bundled',
    target: 'READER_BOOK',
    env: { READER_ENTRY: 'default-book', READER_BOOK: 'acme/missing' },
    sentinels: [],
    problems: ['READER_BOOK "acme/missing" is not a bundled book'],
  },
  {
    id: 'READER_LIBRARY unknown',
    target: 'READER_LIBRARY',
    env: { READER_LIBRARY: 'maybe' },
    sentinels: [],
    problems: ['READER_LIBRARY "maybe" must be one of: on, off'],
  },
  {
    id: 'READER_LIBRARY off with the library entry',
    target: 'READER_LIBRARY',
    env: { READER_LIBRARY: 'off' },
    sentinels: [],
    problems: ['READER_LIBRARY is off but READER_ENTRY is library (the library page is the entry)'],
  },
  {
    id: 'READER_LIBRARY on with single-book',
    target: 'READER_LIBRARY',
    env: { READER_ENTRY: 'single-book', READER_BOOK: 'samples/untitled', READER_LIBRARY: 'on' },
    sentinels: [],
    problems: ['READER_LIBRARY must be off when READER_ENTRY is single-book'],
  },
  {
    id: 'READER_LIBRARY on with no books',
    target: 'READER_LIBRARY',
    env: {},
    ids: [],
    sentinels: [],
    problems: [
      'READER_LIBRARY is on but no books are bundled (add content or set READER_LIBRARY=off)',
    ],
  },
  {
    id: 'READER_UI_LANG unknown',
    target: 'READER_UI_LANG',
    env: { READER_UI_LANG: 'fr' },
    sentinels: [],
    problems: ['READER_UI_LANG "fr" must be one of: auto, en, he'],
  },
  {
    id: 'READER_SRC_ORIGINS with credentials',
    target: 'READER_SRC_ORIGINS',
    env: { READER_SRC_ORIGINS: 'https://SENTINELUSER:SENTINELPASS@content.example.org' },
    sentinels: ['SENTINELUSER', 'SENTINELPASS'],
    problems: [`READER_SRC_ORIGINS entry "https://***@content.example.org" ${ORIGIN_CREDENTIALS}`],
  },
  {
    id: 'READER_SRC_ORIGINS wrong scheme',
    target: 'READER_SRC_ORIGINS',
    env: { READER_SRC_ORIGINS: 'ftp://content.example.org' },
    sentinels: [],
    problems: [
      'READER_SRC_ORIGINS entry "ftp://content.example.org" must use https: (or http: for localhost)',
    ],
  },
  {
    id: 'READER_FETCH_TIMEOUT_SECONDS out of range',
    target: 'READER_FETCH_TIMEOUT_SECONDS',
    env: { READER_FETCH_TIMEOUT_SECONDS: '0' },
    sentinels: [],
    problems: ['READER_FETCH_TIMEOUT_SECONDS "0" must be an integer from 1 to 120'],
  },
  {
    id: 'READER_SRC_MAX_BYTES not a number',
    target: 'READER_SRC_MAX_BYTES',
    env: { READER_SRC_MAX_BYTES: 'big' },
    sentinels: [],
    problems: ['READER_SRC_MAX_BYTES "big" must be an integer from 1024 to 52428800'],
  },
  {
    id: 'READER_SYNC_URL with credentials',
    target: 'READER_SYNC_URL',
    env: {
      READER_SYNC_URL: 'wss://SENTINELSU:SENTINELSP@sync.example.org/ws',
      READER_SYNC_API_KEY: API_KEY,
    },
    sentinels: ['SENTINELSU', 'SENTINELSP'],
    problems: [
      'READER_SYNC_URL "wss://***@sync.example.org/ws" must not contain a user name or password',
    ],
  },
  {
    id: 'READER_SYNC_URL wrong scheme',
    target: 'READER_SYNC_URL',
    env: { READER_SYNC_URL: 'https://sync.example.org/ws', READER_SYNC_API_KEY: API_KEY },
    sentinels: [],
    problems: [
      'READER_SYNC_URL "https://sync.example.org/ws" must use wss: (or ws: for localhost)',
    ],
  },
  {
    id: 'READER_SYNC_API_KEY invalid',
    target: 'READER_SYNC_API_KEY',
    env: { READER_SYNC_URL: SYNC_URL, READER_SYNC_API_KEY: 'SENTINEL key with spaces' },
    sentinels: ['SENTINEL key'],
    problems: [
      'READER_SYNC_API_KEY must be 32 to 256 visible ASCII characters with no spaces (the value is not shown)',
    ],
  },
  {
    id: 'READER_SYNC_API_KEY required',
    target: 'READER_SYNC_API_KEY',
    env: { READER_SYNC_URL: SYNC_URL },
    sentinels: [],
    problems: ['READER_SYNC_API_KEY is required when READER_SYNC_URL is set'],
  },
  {
    id: 'READER_SYNC_API_KEY without the URL',
    target: 'READER_SYNC_API_KEY',
    env: { READER_SYNC_API_KEY: API_KEY },
    sentinels: [],
    problems: ['READER_SYNC_API_KEY is set but READER_SYNC_URL is not (set both, or neither)'],
  },
  {
    id: 'READER_SYNC_APP_VERSION not semver',
    target: 'READER_SYNC_APP_VERSION',
    env: {
      READER_SYNC_URL: SYNC_URL,
      READER_SYNC_API_KEY: API_KEY,
      READER_SYNC_APP_VERSION: 'v1',
    },
    sentinels: [],
    problems: [
      'READER_SYNC_APP_VERSION "v1" must be a semantic version like 1.2.3 (at most 64 characters)',
    ],
  },
  {
    id: 'READER_SYNC_APP_VERSION without the URL',
    target: 'READER_SYNC_APP_VERSION',
    env: { READER_SYNC_APP_VERSION: '1.0.0' },
    sentinels: [],
    problems: ['READER_SYNC_APP_VERSION is set but READER_SYNC_URL is not'],
  },
  {
    id: 'READER_SYNC_LATE_JOIN_SECONDS out of range',
    target: 'READER_SYNC_LATE_JOIN_SECONDS',
    env: {
      READER_SYNC_URL: SYNC_URL,
      READER_SYNC_API_KEY: API_KEY,
      READER_SYNC_LATE_JOIN_SECONDS: '61',
    },
    sentinels: [],
    problems: ['READER_SYNC_LATE_JOIN_SECONDS "61" must be an integer from 0 to 60'],
  },
  {
    id: 'READER_SYNC_LATE_JOIN_SECONDS without the URL',
    target: 'READER_SYNC_LATE_JOIN_SECONDS',
    env: { READER_SYNC_LATE_JOIN_SECONDS: '5' },
    sentinels: [],
    problems: ['READER_SYNC_LATE_JOIN_SECONDS is set but READER_SYNC_URL is not'],
  },
  {
    id: 'PORT out of range',
    target: 'PORT',
    env: { PORT: '70000' },
    sentinels: [],
    problems: ['PORT "70000" must be an integer from 0 to 65535'],
  },
  {
    id: 'unknown READER_ name with a suggestion',
    target: 'unknown',
    env: { READER_SYNC_ULR: 'SENTINEL-ulr' },
    sentinels: ['SENTINEL-ulr'],
    problems: ['READER_SYNC_ULR is not a reader variable; did you mean READER_SYNC_URL?'],
  },
  {
    id: 'unknown READER_ name without a suggestion',
    target: 'unknown',
    env: { READER_THEME: 'SENTINEL-theme' },
    sentinels: ['SENTINEL-theme'],
    problems: [`READER_THEME is not a reader variable; ${HINT}`],
  },
];
