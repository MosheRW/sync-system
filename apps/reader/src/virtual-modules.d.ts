declare module 'virtual:reader-library' {
  import type { LibraryEntry } from './library/types.js';

  /** Every bundled book that passed validation at build time (AC38, AC39). */
  export const entries: readonly LibraryEntry[];
  /** Lazy raw-text loaders, keyed by content ID (ADR 0005 D1). */
  export const loaders: Readonly<Record<string, () => Promise<string>>>;
}
