// Ambient module declarations cannot import relative modules, so the entry
// shape is repeated here; it must match `LibraryEntry` in library/types.ts
// (checked by test/library-plugin.node.test.ts at the type level).
declare module 'virtual:reader-library' {
  /** Every bundled book that passed validation at build time (AC38, AC39). */
  export const entries: readonly {
    contentId: string;
    title?: string;
    lang?: string;
    dir: 'ltr' | 'rtl';
  }[];
  /** Lazy raw-text loaders, keyed by content ID (ADR 0005 D1). */
  export const loaders: Readonly<Record<string, () => Promise<string>>>;
}
