import { SUPPORTED_SCHEMA, type SchemaRange } from './limits.js';
import { type ContentMetadata, parseLeaderMetadata } from './metadata.js';

export type CompareResult =
  'match' | 'different-content' | 'different-version' | 'unsupported-schema';
export type Outcome = 'none' | 'warn' | 'block';

export interface Comparison {
  result: CompareResult;
  outcome: Outcome;
}

/**
 * Compares the local text with the leader's (AC15-AC17). Pure, no I/O.
 * Order: malformed leader metadata -> `unsupported-schema`/`block` (Gate 2
 * Q4); leader schema version outside the supported range ->
 * `unsupported-schema`/`block`; content IDs differ -> `different-content`/
 * `block` (Gate 2 Q3); fingerprints differ -> `different-version`/`warn`;
 * else `match`/`none`.
 */
export function compareContent(
  local: ContentMetadata,
  leader: unknown,
  supported: SchemaRange = SUPPORTED_SCHEMA,
): Comparison {
  const theirs = parseLeaderMetadata(leader);
  if (!theirs) return { result: 'unsupported-schema', outcome: 'block' };
  if (theirs.schemaVersion < supported.min || theirs.schemaVersion > supported.max) {
    return { result: 'unsupported-schema', outcome: 'block' };
  }
  if (theirs.contentId !== local.contentId) {
    return { result: 'different-content', outcome: 'block' };
  }
  if (theirs.fingerprint !== local.fingerprint) {
    return { result: 'different-version', outcome: 'warn' };
  }
  return { result: 'match', outcome: 'none' };
}
