import type { JsonObject } from '@sync-system/react';
import { isContentId } from './content-id.js';
import { FINGERPRINT_PATTERN } from './fingerprint.js';
import { isPlainObject } from './parse.js';

/**
 * What a loaded text is (AC8): ready to hand to the sync client's group
 * metadata (`createGroup(metadata)`, item 8). A type alias, not an
 * interface, so it is assignable to `JsonObject`.
 */
export type ContentMetadata = {
  contentId: string;
  /** 64 lowercase hex characters (ADR 0004 D1). */
  fingerprint: string;
  schemaVersion: number;
};

const METADATA_KEYS = ['contentId', 'fingerprint', 'schemaVersion'] as const;

/** A fresh plain JSON object with exactly the three metadata keys (AC8). */
export function toGroupMetadata(metadata: ContentMetadata): JsonObject {
  const result: JsonObject = {
    contentId: metadata.contentId,
    fingerprint: metadata.fingerprint,
    schemaVersion: metadata.schemaVersion,
  };
  return result;
}

/**
 * Reads a leader's metadata received through the sync service (untrusted).
 * Plain object with exactly the three keys, read as own properties only and
 * never copied before it is checked (security C4). Returns `null` when the
 * value is not valid metadata.
 */
export function parseLeaderMetadata(value: unknown): ContentMetadata | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== METADATA_KEYS.length) return null;
  if (!METADATA_KEYS.every((key) => Object.hasOwn(value, key))) return null;
  const contentId = value['contentId'];
  const fingerprint = value['fingerprint'];
  const schemaVersion = value['schemaVersion'];
  if (!isContentId(contentId)) return null;
  if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) return null;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    return null;
  }
  return { contentId, fingerprint, schemaVersion };
}
