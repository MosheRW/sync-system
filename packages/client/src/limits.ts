import type { AppLimits } from '@sync-system/protocol';

/**
 * Largest `hello.ok` limits the client accepts (M1). Far above the server
 * ceilings from #1 (16 KiB, 10/s, 100). Values outside these bounds mean the
 * server is not supported by this client (R2-L2).
 */
export const CLIENT_LIMIT_BOUNDS: Readonly<AppLimits> = Object.freeze({
  maxGroupSize: 10_000,
  maxLeaderUpdatesPerSecond: 100,
  maxMessageBytes: 1_048_576,
  maxSessionMinutes: 10_080,
});

/** Longest inbound frame (UTF-16 units) before `hello.ok`. */
export const PRE_HANDSHAKE_MAX_CHARS = 8_192;

/** Room for the envelope around metadata and position in one frame. */
export const FRAME_OVERHEAD_CHARS = 8_192;

const LIMIT_KEYS = [
  'maxGroupSize',
  'maxLeaderUpdatesPerSecond',
  'maxMessageBytes',
  'maxSessionMinutes',
] as const;

/** The first limit that is not a positive safe integer within the client bounds, if any. */
export function findOutOfBoundsLimit(limits: AppLimits): keyof AppLimits | undefined {
  for (const key of LIMIT_KEYS) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > CLIENT_LIMIT_BOUNDS[key]) return key;
  }
  return undefined;
}

/**
 * Inbound length guard: `group.joined` can carry metadata and a position of
 * up to `maxMessageBytes` each. A string's UTF-16 length is never more than
 * its UTF-8 byte count, so the guard cannot reject a legal frame.
 */
export function maxInboundChars(limits: AppLimits | undefined): number {
  if (limits === undefined) return PRE_HANDSHAKE_MAX_CHARS;
  return 2 * limits.maxMessageBytes + FRAME_OVERHEAD_CHARS;
}
