import { isContentId } from '../content/content-id.js';
import { checkAllowedOrigin, isLoopbackHttpOrigin, type OriginIssue } from '../content/origin.js';
import { truncate } from '../content/quote.js';
import { z } from '../content/zod.js';
import { ConfigError } from './config-error.js';

export const ENTRY_MODES = ['library', 'error', 'default-book', 'single-book'] as const;
export const UI_LANG_SETTINGS = ['auto', 'en', 'he'] as const;
export type EntryMode = (typeof ENTRY_MODES)[number];
export type UiLangSetting = (typeof UI_LANG_SETTINGS)[number];
export type LibrarySetting = 'on' | 'off';

export const CONFIG_LIMITS = {
  fetchTimeoutSeconds: { min: 1, max: 120, default: 15 },
  srcMaxBytes: { min: 1024, max: 52_428_800, default: 5_242_880 },
  port: { min: 0, max: 65_535, default: 8080 },
} as const;

/** What the browser receives (injected into index.html). Public by design: never a secret. */
export interface PublicConfig {
  entry: EntryMode;
  book: string | null;
  library: LibrarySetting;
  uiLang: UiLangSetting;
  srcOrigins: string[];
  fetchTimeoutSeconds: number;
  srcMaxBytes: number;
}

export interface ReaderConfig extends PublicConfig {
  port: number;
  host: string;
  /** Non-fatal startup notes (security F9), printed by the server. */
  warnings: string[];
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

const ORIGIN_ISSUES: Record<OriginIssue, string> = {
  'not-a-url': 'is not a URL',
  scheme: 'must use https: (or http: for localhost)',
  'http-not-loopback': 'must use https: (http: is allowed only for localhost, 127.0.0.1 and [::1])',
  credentials: 'must not contain a user name or password',
  wildcard: 'must not contain a wildcard',
  'not-canonical':
    'must be an exact origin like https://host[:port] (no path, query, trailing slash, uppercase or default port)',
};

function read(env: EnvSource, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

const shown = (value: string) => `"${truncate(value)}"`;

function parseInteger(
  env: EnvSource,
  name: string,
  limits: { min: number; max: number; default: number },
  problems: string[],
): number {
  const raw = read(env, name);
  if (raw === undefined) return limits.default;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < limits.min || value > limits.max) {
    problems.push(`${name} ${shown(raw)} must be an integer from ${limits.min} to ${limits.max}`);
    return limits.default;
  }
  return value;
}

function parseChoice<T extends string>(
  env: EnvSource,
  name: string,
  choices: readonly T[],
  fallback: T,
  problems: string[],
): T {
  const raw = read(env, name);
  if (raw === undefined) return fallback;
  if ((choices as readonly string[]).includes(raw)) return raw as T;
  problems.push(`${name} ${shown(raw)} must be one of: ${choices.join(', ')}`);
  return fallback;
}

/**
 * Parses and validates the reader's environment (ADR 0005, ADR 0006) against
 * the bundled library IDs. Collects every problem and throws one
 * `ConfigError` listing them all (AC30, AC41). The single source of the
 * rules for the server, the Vite dev/preview servers and the tests.
 */
export function parseReaderConfig(env: EnvSource, libraryIds: readonly string[]): ReaderConfig {
  const problems: string[] = [];
  const warnings: string[] = [];

  const entry = parseChoice(env, 'READER_ENTRY', ENTRY_MODES, 'library', problems);
  const uiLang = parseChoice(env, 'READER_UI_LANG', UI_LANG_SETTINGS, 'auto', problems);
  const library = parseChoice<LibrarySetting>(
    env,
    'READER_LIBRARY',
    ['on', 'off'],
    entry === 'single-book' ? 'off' : 'on',
    problems,
  );

  const rawBook = read(env, 'READER_BOOK');
  let book: string | null = null;
  const needsBook = entry === 'default-book' || entry === 'single-book';
  if (needsBook && rawBook === undefined) {
    problems.push(`READER_BOOK is required when READER_ENTRY is ${entry}`);
  } else if (!needsBook && rawBook !== undefined) {
    problems.push(
      `READER_BOOK is set but READER_ENTRY is ${entry}, which never opens it (use default-book or single-book, or unset READER_BOOK)`,
    );
  } else if (rawBook !== undefined) {
    if (!isContentId(rawBook)) {
      problems.push(`READER_BOOK ${shown(rawBook)} is not a content ID (namespace/slug)`);
    } else if (!libraryIds.includes(rawBook)) {
      problems.push(`READER_BOOK ${shown(rawBook)} is not a bundled book`);
    } else {
      book = rawBook;
    }
  }

  if (entry === 'library' && library === 'off') {
    problems.push(
      'READER_LIBRARY is off but READER_ENTRY is library (the library page is the entry)',
    );
  }
  if (entry === 'single-book' && library === 'on') {
    problems.push('READER_LIBRARY must be off when READER_ENTRY is single-book');
  }
  if (library === 'on' && libraryIds.length === 0) {
    problems.push(
      'READER_LIBRARY is on but no books are bundled (add content or set READER_LIBRARY=off)',
    );
  }

  const srcOrigins: string[] = [];
  const rawOrigins = read(env, 'READER_SRC_ORIGINS');
  if (rawOrigins !== undefined) {
    for (const item of rawOrigins.split(',')) {
      const entryValue = item.trim();
      if (entryValue === '') continue;
      const checked = checkAllowedOrigin(entryValue);
      if (!checked.ok) {
        problems.push(
          `READER_SRC_ORIGINS entry ${shown(entryValue)} ${ORIGIN_ISSUES[checked.issue]}`,
        );
      } else if (!srcOrigins.includes(checked.origin)) {
        srcOrigins.push(checked.origin);
      }
    }
  }
  if (read(env, 'NODE_ENV') === 'production') {
    for (const origin of srcOrigins.filter(isLoopbackHttpOrigin)) {
      warnings.push(
        `READER_SRC_ORIGINS contains ${origin} in production: any ?src link can then make readers' browsers call that port on their own machine (development only)`,
      );
    }
  }

  const fetchTimeoutSeconds = parseInteger(
    env,
    'READER_FETCH_TIMEOUT_SECONDS',
    CONFIG_LIMITS.fetchTimeoutSeconds,
    problems,
  );
  const srcMaxBytes = parseInteger(
    env,
    'READER_SRC_MAX_BYTES',
    CONFIG_LIMITS.srcMaxBytes,
    problems,
  );
  const port = parseInteger(env, 'PORT', CONFIG_LIMITS.port, problems);
  const host = read(env, 'HOST') ?? '0.0.0.0';

  if (problems.length > 0) throw new ConfigError(problems);
  return {
    entry,
    book,
    library,
    uiLang,
    srcOrigins,
    fetchTimeoutSeconds,
    srcMaxBytes,
    port,
    host,
    warnings,
  };
}

/**
 * The config the browser gets, built from an explicit field list (never a
 * spread of the env or of the config object, security C5).
 */
export function publicConfig(config: PublicConfig): PublicConfig {
  return {
    entry: config.entry,
    book: config.book,
    library: config.library,
    uiLang: config.uiLang,
    srcOrigins: [...config.srcOrigins],
    fetchTimeoutSeconds: config.fetchTimeoutSeconds,
    srcMaxBytes: config.srcMaxBytes,
  };
}

const publicConfigSchema = z
  .strictObject({
    entry: z.enum(ENTRY_MODES),
    book: z.string().refine(isContentId).nullable(),
    library: z.enum(['on', 'off']),
    uiLang: z.enum(UI_LANG_SETTINGS),
    srcOrigins: z.array(z.string().refine((origin) => checkAllowedOrigin(origin).ok)).max(100),
    fetchTimeoutSeconds: z
      .number()
      .int()
      .min(CONFIG_LIMITS.fetchTimeoutSeconds.min)
      .max(CONFIG_LIMITS.fetchTimeoutSeconds.max),
    srcMaxBytes: z
      .number()
      .int()
      .min(CONFIG_LIMITS.srcMaxBytes.min)
      .max(CONFIG_LIMITS.srcMaxBytes.max),
  })
  .refine(
    (config) =>
      (config.entry === 'default-book' || config.entry === 'single-book') ===
      (config.book !== null),
  )
  .refine((config) => config.entry !== 'single-book' || config.library === 'off')
  .refine((config) => config.entry !== 'library' || config.library === 'on');

/** The browser re-validates the injected config; `null` shows "app isn't set up" (C5). */
export function parsePublicConfig(value: unknown): PublicConfig | null {
  const result = publicConfigSchema.safeParse(value);
  return result.success ? result.data : null;
}
