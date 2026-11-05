import { type ClientErrorCode, SyncClientError, isSyncClientError } from '@sync-system/client';

/**
 * Keeps a `SyncClientError` as is; anything else (not expected from the core)
 * becomes a fresh `SyncClientError` with `fallback` (`INTERNAL_ERROR` unless
 * given), so the error state stays typed. The original value is dropped: an
 * app error may hold app data, and nothing of it is kept or logged (AC27).
 */
export function toSyncError(
  value: unknown,
  fallback: ClientErrorCode = 'INTERNAL_ERROR',
): SyncClientError {
  return isSyncClientError(value) ? value : new SyncClientError(fallback);
}
