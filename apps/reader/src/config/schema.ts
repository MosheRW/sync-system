import { isContentId } from '../content/content-id.js';
import { checkAllowedOrigin, isLoopbackHttpOrigin, type OriginIssue } from '../content/origin.js';
import { truncate } from '../content/quote.js';
import { z } from '../content/zod.js';
import { ConfigError } from './config-error.js';
import { type SyncUrlIssue, checkSyncUrl } from './sync-url.js';
import { READER_VERSION } from './version.js';

export const ENTRY_MODES = ['library', 'error', 'default-book', 'single-book'] as const;
export const UI_LANG_SETTINGS = ['auto', 'en', 'he'] as const;
export type EntryMode = (typeof ENTRY_MODES)[number];
export type UiLangSetting = (typeof UI_LANG_SETTINGS)[number];
export type LibrarySetting = 'on' | 'off';

export const CONFIG_LIMITS = {
  fetchTimeoutSeconds: { min: 1, max: 120, default: 15 },
  srcMaxBytes: { min: 1024, max: 52_428_800, default: 5_242_880 },
  port: { min: 0, max: 65_535, default: 8080 },
  /** Late-joiner countdown (#24 Decision Q5); 0 jumps at once. */
  syncLateJoinSeconds: { min: 0, max: 60, default: 10 },
} as const;

/** The sync API key: the server's minimum and the client's maximum length, visible ASCII. */
export const SYNC_API_KEY_PATTERN = /^[!-~]{32,256}$/;

/**
 * Semver `MAJOR.MINOR.PATCH[-pre][+build]` (semver.org's pattern). At most
 * 64 characters: the sync server refuses longer versions.
 */
export const SYNC_APP_VERSION_MAX_LENGTH = 64;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isSyncAppVersion(value: string): boolean {
  return value.length <= SYNC_APP_VERSION_MAX_LENGTH && SEMVER_PATTERN.test(value);
}

/**
 * API keys that are public because they are committed to the repo
 * (`config/apps.dev.json`); the sync server refuses them outside development
 * (#1 M6). A test keeps this list equal to that file.
 */
export const PUBLIC_DEV_API_KEYS: readonly string[] = [
  'dev-only-insecure-api-key-change-me-please',
];

/**
 * The sync settings the browser needs (#24 AC1). The API key is public by
 * nature (it ships in the page, Decision Q9): it identifies the app and
 * grants nothing on its own.
 */
export interface SyncConfig {
  /** The checked `href` of `READER_SYNC_URL`. */
  url: string;
  apiKey: string;
  appVersion: string;
  lateJoinSeconds: number;
}

/** What the browser receives (injected into index.html). Public by design: never a secret. */
export interface PublicConfig {
  entry: EntryMode;
  book: string | null;
  library: LibrarySetting;
  uiLang: UiLangSetting;
  srcOrigins: string[];
  fetchTimeoutSeconds: number;
  srcMaxBytes: number;
  /** `null`: sync is off (no `READER_SYNC_URL`); the reader is the solo reader (AC2). */
  sync: SyncConfig | null;
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
  'http-not-loopback': 'must use https: (http: is allowed only for localhost and 127.0.0.1)',
  credentials: 'must not contain a user name or password',
  wildcard: 'must not contain a wildcard',
  host: 'must have a plain host name or IPv4 address (letters, digits, hyphens and dots)',
  'not-canonical':
    'must be an exact origin like https://host[:port] (no path, query, trailing slash, uppercase or default port)',
};

const SYNC_URL_ISSUES: Record<SyncUrlIssue, string> = {
  'not-a-url': 'is not a URL',
  scheme: 'must use wss: (or ws: for localhost)',
  'ws-not-loopback': 'must use wss: (ws: is allowed only for localhost and 127.0.0.1)',
  credentials: 'must not contain a user name or password',
  query: 'must not contain a query',
  fragment: 'must not contain a fragment',
  host: 'must have a plain host name or IPv4 address (letters, digits, hyphens and dots)',
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
 * `READER_SYNC_*` (#24 AC1). Sync is on exactly when `READER_SYNC_URL` is
 * set. The API key is never quoted: a problem names the variable and the
 * rule only (R2).
 */
function parseSync(env: EnvSource, problems: string[], warnings: string[]): SyncConfig | null {
  const rawUrl = read(env, 'READER_SYNC_URL');
  const rawKey = read(env, 'READER_SYNC_API_KEY');
  const rawVersion = read(env, 'READER_SYNC_APP_VERSION');
  const rawLate = read(env, 'READER_SYNC_LATE_JOIN_SECONDS');

  if (rawUrl === undefined) {
    if (rawKey !== undefined) {
      problems.push('READER_SYNC_API_KEY is set but READER_SYNC_URL is not (set both, or neither)');
    }
    if (rawVersion !== undefined) {
      problems.push('READER_SYNC_APP_VERSION is set but READER_SYNC_URL is not');
    }
    if (rawLate !== undefined) {
      problems.push('READER_SYNC_LATE_JOIN_SECONDS is set but READER_SYNC_URL is not');
    }
    return null;
  }

  const checked = checkSyncUrl(rawUrl);
  if (!checked.ok) {
    problems.push(`READER_SYNC_URL ${shown(rawUrl)} ${SYNC_URL_ISSUES[checked.issue]}`);
  }

  const keyOk = rawKey !== undefined && SYNC_API_KEY_PATTERN.test(rawKey);
  if (rawKey === undefined) {
    problems.push('READER_SYNC_API_KEY is required when READER_SYNC_URL is set');
  } else if (!keyOk) {
    problems.push(
      'READER_SYNC_API_KEY must be 32 to 256 visible ASCII characters with no spaces (the value is not shown)',
    );
  }

  let appVersion = READER_VERSION;
  if (rawVersion !== undefined) {
    if (isSyncAppVersion(rawVersion)) appVersion = rawVersion;
    else {
      problems.push(
        `READER_SYNC_APP_VERSION ${shown(rawVersion)} must be a semantic version like 1.2.3 (at most ${SYNC_APP_VERSION_MAX_LENGTH} characters)`,
      );
    }
  }

  const lateJoinSeconds = parseInteger(
    env,
    'READER_SYNC_LATE_JOIN_SECONDS',
    CONFIG_LIMITS.syncLateJoinSeconds,
    problems,
  );

  if (read(env, 'NODE_ENV') === 'production') {
    if (checked.ok && checked.loopbackWs) {
      warnings.push(
        'READER_SYNC_URL uses ws: (unencrypted) in production: expected for the local compose setup; use wss: for real use',
      );
    }
    if (rawKey !== undefined && PUBLIC_DEV_API_KEYS.includes(rawKey)) {
      warnings.push(
        'READER_SYNC_API_KEY is the public development key in production: the sync server refuses it outside development; register the reader with its own key',
      );
    }
  }

  if (!checked.ok || !keyOk) return null;
  return { url: checked.href, apiKey: rawKey, appVersion, lateJoinSeconds };
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
  const sync = parseSync(env, problems, warnings);
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
    sync,
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
    sync:
      config.sync === null
        ? null
        : {
            url: config.sync.url,
            apiKey: config.sync.apiKey,
            appVersion: config.sync.appVersion,
            lateJoinSeconds: config.sync.lateJoinSeconds,
          },
  };
}

const syncConfigSchema = z.strictObject({
  url: z.string().refine((url) => {
    const checked = checkSyncUrl(url);
    return checked.ok && checked.href === url;
  }),
  apiKey: z.string().regex(SYNC_API_KEY_PATTERN),
  appVersion: z.string().refine(isSyncAppVersion),
  lateJoinSeconds: z
    .number()
    .int()
    .min(CONFIG_LIMITS.syncLateJoinSeconds.min)
    .max(CONFIG_LIMITS.syncLateJoinSeconds.max),
});

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
    sync: syncConfigSchema.nullable(),
  })
  .refine(
    (config) =>
      (config.entry === 'default-book' || config.entry === 'single-book') ===
      (config.book !== null),
  )
  .refine((config) => config.entry !== 'single-book' || config.library === 'off')
  .refine((config) => config.entry !== 'library' || config.library === 'on');

/**
 * The browser's check of the injected config (C5). `sync`: everything is
 * valid except the sync settings (design F0.2 shows their own details);
 * `config`: anything else. Both show "This app isn't set up".
 */
export type PublicConfigResult =
  { ok: true; config: PublicConfig } | { ok: false; reason: 'sync' | 'config' };

export function parsePublicConfig(value: unknown): PublicConfigResult {
  const result = publicConfigSchema.safeParse(value);
  if (result.success) return { ok: true, config: result.data };
  const syncOnly =
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'sync') &&
    publicConfigSchema.safeParse({ ...value, sync: null }).success;
  return { ok: false, reason: syncOnly ? 'sync' : 'config' };
}
