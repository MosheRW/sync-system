import type { SyncClientError, SyncClientSnapshot } from '@sync-system/client';
import type { UpdateRequired } from './types.js';

/**
 * The typed "update required" state (AC14) from the closed connection's
 * error, else the last error event. Only numbers and the (core-trimmed)
 * `minAppVersion` string are copied; no server text.
 */
export function updateRequiredOf(
  snapshot: SyncClientSnapshot,
  lastError: SyncClientError | null,
): UpdateRequired | null {
  const { connection } = snapshot;
  const closedError = connection.status === 'closed' ? connection.error : undefined;
  return fromError(closedError) ?? fromError(lastError ?? undefined);
}

function fromError(error: SyncClientError | undefined): UpdateRequired | null {
  if (error === undefined) return null;
  switch (error.code) {
    case 'APP_VERSION_TOO_OLD': {
      const details = (error as SyncClientError<'APP_VERSION_TOO_OLD'>).details;
      const min = details?.minAppVersion;
      return Object.freeze(
        typeof min === 'string'
          ? { kind: 'app' as const, minAppVersion: min }
          : { kind: 'app' as const },
      );
    }
    case 'PROTOCOL_TOO_OLD': {
      const details = (error as SyncClientError<'PROTOCOL_TOO_OLD'>).details;
      const min = details?.minProtocolVersion;
      return Object.freeze(
        typeof min === 'number' && Number.isFinite(min)
          ? { kind: 'protocol' as const, minProtocolVersion: min }
          : { kind: 'protocol' as const },
      );
    }
    case 'SERVER_UNSUPPORTED': {
      const details = (error as SyncClientError<'SERVER_UNSUPPORTED'>).details;
      return Object.freeze({
        kind: 'server_unsupported' as const,
        serverProtocolVersion: details?.serverProtocolVersion ?? Number.NaN,
        serverMinProtocolVersion: details?.serverMinProtocolVersion ?? Number.NaN,
      });
    }
    default:
      return null;
  }
}

/** Structural equality of two update-required values (for the selector hook). */
export function sameUpdateRequired(a: UpdateRequired | null, b: UpdateRequired | null): boolean {
  if (a === b) return true;
  if (a === null || b === null || a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'app':
      return a.minAppVersion === (b as typeof a).minAppVersion;
    case 'protocol':
      return a.minProtocolVersion === (b as typeof a).minProtocolVersion;
    case 'server_unsupported':
      return (
        Object.is(a.serverProtocolVersion, (b as typeof a).serverProtocolVersion) &&
        Object.is(a.serverMinProtocolVersion, (b as typeof a).serverMinProtocolVersion)
      );
  }
}
