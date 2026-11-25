import type { EnvSource } from './env.js';

/**
 * Every environment variable the sync server reads (ADR 0015). The parser,
 * the unknown-variable check, the README drift test and the config matrix
 * test all use this one list: adding a variable means adding it here.
 */
export const KNOWN_SERVER_VARIABLES = [
  'PORT',
  'HOST',
  'LOG_LEVEL',
  'NODE_ENV',
  'SYNC_CONFIG_PATH',
  'MAX_GROUP_SIZE_CEILING',
  'MAX_LEADER_UPDATE_RATE_CEILING',
  'MAX_MESSAGE_SIZE_CEILING',
  'MAX_APP_CONNECTIONS_CEILING',
  'MAX_CONNECTIONS',
  'MAX_PENDING_HANDSHAKES',
  'MAX_INBOUND_MESSAGES_PER_SECOND',
  'MAX_INBOUND_BURST',
  'MAX_BUFFERED_BYTES',
  'MAX_SESSION_MINUTES_CEILING',
  'INACTIVITY_LIMIT_MINUTES_CEILING',
  'TOKEN_REFRESH_ACTIVITIES',
  'TOKEN_REFRESH_MIN_SECONDS',
  'TOKEN_REFRESH_MAX_SECONDS',
  'JOIN_METHODS_ALLOWED',
  'QR_TICKET_SECONDS_CEILING',
  'APPROVAL_TIMEOUT_SECONDS_CEILING',
  'DISCONNECT_GRACE_SECONDS_CEILING',
  'KEEP_ALIVE_COUNTDOWN_SECONDS_CEILING',
  'MAX_GROUP_CREATES_PER_CONNECTION_PER_MINUTE',
  'MAX_GROUP_CREATE_BURST_PER_APP',
  'MAX_GROUP_CREATES_PER_APP_PER_MINUTE',
  'MAX_LIVE_GROUPS_PER_APP',
  'TOKEN_SECRET',
  'TOKEN_SECRET_PREVIOUS',
  'TOKEN_SECRET_FILE',
  'TOKEN_SECRET_PREVIOUS_FILE',
  'REDIS_URL',
  'REDIS_URL_FILE',
  'REDIS_KEY_PREFIX',
  'REDIS_CONNECT_TIMEOUT_SECONDS',
  'REDIS_COMMAND_TIMEOUT_MS',
] as const;

export type ServerVariable = (typeof KNOWN_SERVER_VARIABLES)[number];

/** Name prefixes of the server's own variables (ADR 0015 option 1). */
export const SERVER_FAMILY_PREFIXES: readonly string[] = [
  'MAX_',
  'TOKEN_',
  'REDIS_',
  'SYNC_',
  'JOIN_',
  'QR_',
  'APPROVAL_',
  'DISCONNECT_',
  'KEEP_ALIVE_',
  'INACTIVITY_',
];

/** Name suffix of the server's own variables (ADR 0015 option 1). */
export const SERVER_FAMILY_SUFFIX = '_CEILING';

/** The repo's test harness (`SYNC_TEST_STORE`, `SYNC_TEST_REDIS_URL`): never flagged. */
export const TEST_HARNESS_PREFIX = 'SYNC_TEST_';

/**
 * Names that Kubernetes service links and Docker `--link` inject, matched on
 * the upper-case name: `_SERVICE_HOST`, `_SERVICE_PORT`, `_SERVICE_PORT_*`,
 * `_PORT`, `_PORT_<n>_TCP|UDP|SCTP` (optionally `_ADDR|_PORT|_PROTO`),
 * `_NAME`, `_ENV_*`. They are never flagged (ADR 0015). The reader keeps an
 * identical copy; a test in each package pins it.
 */
export const PLATFORM_SUFFIXES: readonly RegExp[] = [
  /_SERVICE_HOST$/,
  /_SERVICE_PORT$/,
  /_SERVICE_PORT_[A-Z0-9_]+$/,
  /_PORT$/,
  /_PORT_[0-9]+_(TCP|UDP|SCTP)(_(ADDR|PORT|PROTO))?$/,
  /_NAME$/,
  /_ENV_[A-Z0-9_]+$/,
];

/** Only names of this shape are considered; values are never read (security C4). */
export const VARIABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Longest flagged name printed; longer names are cut and end in `...` (security L4). */
export const MAX_SHOWN_NAME = 48;

/** Largest edit distance for a "did you mean" suggestion (Gate 2 Q-5). */
export const MAX_SUGGESTION_DISTANCE = 2;

const KNOWN = new Set<string>(KNOWN_SERVER_VARIABLES);

/** Whether a name (compared in upper case) is in one of the server's families. */
export function isServerFamilyName(name: string): boolean {
  if (!VARIABLE_NAME_PATTERN.test(name)) return false;
  const upper = name.toUpperCase();
  return (
    SERVER_FAMILY_PREFIXES.some((prefix) => upper.startsWith(prefix)) ||
    upper.endsWith(SERVER_FAMILY_SUFFIX)
  );
}

/** Whether a name (compared in upper case) is shaped like a platform link name. */
export function isPlatformName(name: string): boolean {
  const upper = name.toUpperCase();
  return PLATFORM_SUFFIXES.some((suffix) => suffix.test(upper));
}

/**
 * Optimal string alignment distance (Damerau-Levenshtein with adjacent
 * transpositions), case-insensitive. Used on names only.
 */
export function editDistance(a: string, b: string): number {
  const s = a.toUpperCase();
  const t = b.toUpperCase();
  const rows = s.length + 1;
  const cols = t.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = best;
    }
  }
  return d[rows - 1]![cols - 1]!;
}

function cut(name: string): string {
  return name.length > MAX_SHOWN_NAME ? `${name.slice(0, MAX_SHOWN_NAME)}...` : name;
}

/** The closest known name within MAX_SUGGESTION_DISTANCE edits, if any. */
function suggestion(name: string): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const known of KNOWN_SERVER_VARIABLES) {
    const distance = editDistance(name, known);
    if (distance > MAX_SUGGESTION_DISTANCE) continue;
    if (best === undefined || distance < best.distance) best = { name: known, distance };
  }
  return best?.name;
}

/**
 * The set names that look like server variables but are not known (ADR
 * 0015), sorted. Reads names only: values are never touched (security C4).
 */
export function unknownServerVariables(env: EnvSource): string[] {
  return Object.keys(env)
    .filter(
      (name) =>
        env[name] !== undefined &&
        !KNOWN.has(name) &&
        isServerFamilyName(name) &&
        !name.toUpperCase().startsWith(TEST_HARNESS_PREFIX) &&
        !isPlatformName(name),
    )
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Pushes one problem per unknown look-alike variable (#36 AC37a, ADR 0015).
 * The name is cut to MAX_SHOWN_NAME before it is printed or compared; the
 * suggestion comes from KNOWN_SERVER_VARIABLES only.
 */
export function collectUnknownVariables(env: EnvSource, problems: string[]): void {
  for (const name of unknownServerVariables(env)) {
    const shown = cut(name);
    const known = name.length > MAX_SHOWN_NAME ? undefined : suggestion(name);
    problems.push(
      known === undefined
        ? `${shown} is not a sync server variable; remove it or fix the name (see "Environment variables" in docs/operator-guide.md)`
        : `${shown} is not a sync server variable; did you mean ${known}?`,
    );
  }
}
