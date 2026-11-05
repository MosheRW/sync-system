// Schema v1 limits (ADR 0004). Fixed per schema version: changing one means a
// new schema version. Pure module, also compiled for the Node server.

export const CONTENT_LIMITS = {
  pages: 5000,
  blocksPerPage: 1000,
  textLength: 20_000,
  titleLength: 200,
  langLength: 35,
  namespaceLength: 64,
  slugLength: 128,
  /** namespace + "/" + slug; checked before any regex runs (security F7). */
  contentIdLength: 64 + 1 + 128,
} as const;

/** Schema versions this app can render (AC3, AC17). */
export interface SchemaRange {
  readonly min: number;
  readonly max: number;
}

export const SUPPORTED_SCHEMA: SchemaRange = Object.freeze({ min: 1, max: 1 });

/** Longest value quoted from a file or a URL in error details (design.md 8). */
export const QUOTE_MAX_LENGTH = 40;
