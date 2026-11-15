import type { EnvSource } from './schema.js';

/**
 * Every `READER_*` variable the reader reads (ADR 0015, #36 Gate 2 Q-2).
 * Adding a variable means adding it here; a test keeps it equal to the
 * README table.
 */
export const KNOWN_READER_VARIABLES = [
  'READER_ENTRY',
  'READER_BOOK',
  'READER_LIBRARY',
  'READER_UI_LANG',
  'READER_SRC_ORIGINS',
  'READER_FETCH_TIMEOUT_SECONDS',
  'READER_SRC_MAX_BYTES',
  'READER_SYNC_URL',
  'READER_SYNC_API_KEY',
  'READER_SYNC_APP_VERSION',
  'READER_SYNC_LATE_JOIN_SECONDS',
] as const;

/** The reader's single name family (ADR 0015). */
export const READER_FAMILY_PREFIX = 'READER_';

/**
 * Names that Kubernetes service links and Docker `--link` inject, matched on
 * the upper-case name; never flagged. The same list as the sync server's
 * `PLATFORM_SUFFIXES` (`apps/sync-server/src/config/known-vars.ts`); a test
 * in each package pins it.
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

/** Only names of this shape are considered; values are never read. */
export const VARIABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Longest flagged name printed; longer names are cut and end in `...`. */
export const MAX_SHOWN_NAME = 48;

/** Largest edit distance for a "did you mean" suggestion. */
export const MAX_SUGGESTION_DISTANCE = 2;

const KNOWN = new Set<string>(KNOWN_READER_VARIABLES);

/** Whether a name (compared in upper case) is in the reader's family. */
export function isReaderFamilyName(name: string): boolean {
  return VARIABLE_NAME_PATTERN.test(name) && name.toUpperCase().startsWith(READER_FAMILY_PREFIX);
}

function isPlatformName(name: string): boolean {
  const upper = name.toUpperCase();
  return PLATFORM_SUFFIXES.some((suffix) => suffix.test(upper));
}

/** Optimal string alignment distance, case-insensitive. Names only. */
export function editDistance(a: string, b: string): number {
  const s = a.toUpperCase();
  const t = b.toUpperCase();
  const d: number[][] = Array.from({ length: s.length + 1 }, (_, i) =>
    Array.from({ length: t.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= s.length; i += 1) {
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        best = Math.min(best, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = best;
    }
  }
  return d[s.length]![t.length]!;
}

function suggestion(name: string): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const known of KNOWN_READER_VARIABLES) {
    const distance = editDistance(name, known);
    if (distance > MAX_SUGGESTION_DISTANCE) continue;
    if (best === undefined || distance < best.distance) best = { name: known, distance };
  }
  return best?.name;
}

/** Set `READER_*` names that are not reader variables, sorted. Reads names only. */
export function unknownReaderVariables(env: EnvSource): string[] {
  return Object.keys(env)
    .filter(
      (name) =>
        env[name] !== undefined &&
        !KNOWN.has(name) &&
        isReaderFamilyName(name) &&
        !isPlatformName(name),
    )
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * One problem per unknown `READER_*` variable (#36 Gate 2 Q-2, ADR 0015).
 * Never reads or prints a value; the name is cut before it is compared or
 * printed, and the suggestion comes from KNOWN_READER_VARIABLES only.
 */
export function collectUnknownReaderVariables(env: EnvSource, problems: string[]): void {
  for (const name of unknownReaderVariables(env)) {
    const long = name.length > MAX_SHOWN_NAME;
    const shownName = long ? `${name.slice(0, MAX_SHOWN_NAME)}...` : name;
    const known = long ? undefined : suggestion(name);
    problems.push(
      known === undefined
        ? `${shownName} is not a reader variable; remove it or fix the name (see "Configuration" in apps/reader/README.md)`
        : `${shownName} is not a reader variable; did you mean ${known}?`,
    );
  }
}
