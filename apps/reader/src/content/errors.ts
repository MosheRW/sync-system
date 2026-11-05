import type { ContentIdIssue } from './content-id.js';

/** Why a file failed validation (first problem found). */
export type InvalidContentCode =
  | 'not-an-object'
  | 'unknown-field'
  | 'missing-field'
  | 'wrong-type'
  | 'invalid-value'
  | 'invalid-content-id'
  | 'invalid-lang'
  | 'invalid-text'
  | 'empty'
  | 'too-long'
  | 'too-many';

/** Every typed reason the loader can refuse or fail to load content (AC3-AC5). */
export type ContentError =
  | { kind: 'network' }
  | { kind: 'http'; status: number }
  | { kind: 'timeout'; seconds: number }
  | { kind: 'too-large'; maxBytes: number }
  | { kind: 'src-not-allowed'; origin: string }
  | { kind: 'src-invalid' }
  | { kind: 'invalid-json' }
  | {
      kind: 'invalid-content';
      /** "Page 3, block 2", or "" for a document-level field. */
      path: string;
      code: InvalidContentCode;
      /** Author-facing text; quoted values are truncated to 40 characters. */
      detail: string;
      contentIdIssue?: ContentIdIssue;
    }
  | { kind: 'schema-version-missing' }
  | { kind: 'schema-version-invalid' }
  | { kind: 'schema-version-unsupported'; version: number; min: number; max: number }
  | { kind: 'crypto-unavailable' }
  | { kind: 'not-found'; contentId: string }
  | { kind: 'aborted' };

export type ContentErrorKind = ContentError['kind'];

/** Fetch failures can succeed on retry; refused files never do (design.md 8). */
export function isRetryable(error: ContentError): boolean {
  return error.kind === 'network' || error.kind === 'http' || error.kind === 'timeout';
}
