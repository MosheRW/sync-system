import type { JsonObject } from '@sync-system/react';
import { isPlainObject } from '../content/parse.js';

/**
 * The group position the reader sends and accepts (#24 AC29, architecture
 * section 6), version 1: `{ "v": 1, "pageIndex": <zero-based page> }`. It is
 * the reader's contract with other readers; the sync server never reads it.
 * A breaking or additive change bumps `v`: a reader accepts only versions it
 * knows, so an old member never jumps to a misread page.
 */
export const POSITION_VERSION = 1;

const POSITION_KEYS = ['v', 'pageIndex'] as const;

/** A fresh object with exactly the two keys. */
export function encodePosition(pageIndex: number): JsonObject {
  const position: JsonObject = { v: POSITION_VERSION, pageIndex };
  return position;
}

/**
 * Reads a position received through the sync service (untrusted): a plain
 * object with exactly the own keys `v` and `pageIndex`, `v === 1`, and a
 * safe integer page index inside the loaded book. Anything else is `null`
 * and is ignored by the caller: no move, no prompt, no error (AC29).
 */
export function decodePosition(value: unknown, pageCount: number): number | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== POSITION_KEYS.length) return null;
  if (!POSITION_KEYS.every((key) => Object.hasOwn(value, key))) return null;
  if (value['v'] !== POSITION_VERSION) return null;
  const pageIndex = value['pageIndex'];
  if (typeof pageIndex !== 'number' || !Number.isSafeInteger(pageIndex)) return null;
  if (pageIndex < 0 || pageIndex >= pageCount) return null;
  return pageIndex;
}
