/** One bundled book in the build-time library index (ADR 0005 D1). Shared with the server. */
export interface LibraryEntry {
  contentId: string;
  title?: string;
  lang?: string;
  /** The effective document direction (default `ltr`). */
  dir: 'ltr' | 'rtl';
}
