import { type AppLimits, MAX_TOKEN_LENGTH } from '@mosherw/sync-system-protocol';

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
  // Match the server's env ceiling bounds (#10 architecture 5.1).
  qrTicketSeconds: 86_400,
  approvalTimeoutSeconds: 3_600,
  // Match the server's env ceiling bounds (#13 architecture 8.1).
  inactivityLimitMinutes: 10_080,
  disconnectGraceSeconds: 3_600,
  keepAliveCountdownSeconds: 3_600,
});

/** Longest inbound frame (UTF-16 units) before `hello.ok`. */
export const PRE_HANDSHAKE_MAX_CHARS = 8_192;

/** Room for the envelope around metadata and position in one frame. */
export const FRAME_OVERHEAD_CHARS = 8_192;

/** A tokens.result with 20 re-signed tokens of 2048 characters plus the envelope (#5). */
export const TOKENS_CHECK_MAX_FRAME_CHARS = 45_056;

const LIMIT_KEYS = [
  'maxGroupSize',
  'maxLeaderUpdatesPerSecond',
  'maxMessageBytes',
  'maxSessionMinutes',
  'qrTicketSeconds',
  'approvalTimeoutSeconds',
  'inactivityLimitMinutes',
  'disconnectGraceSeconds',
  'keepAliveCountdownSeconds',
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
 * Inbound length guard: `group.joined` and `group.resumed` can carry
 * metadata and a position of up to `maxMessageBytes` each plus a token, and
 * `tokens.result` up to 20 tokens. A string's UTF-16 length is never more
 * than its UTF-8 byte count, so the guard cannot reject a legal frame.
 */
export function maxInboundChars(limits: AppLimits | undefined): number {
  if (limits === undefined) return PRE_HANDSHAKE_MAX_CHARS;
  return Math.max(
    2 * limits.maxMessageBytes + FRAME_OVERHEAD_CHARS + MAX_TOKEN_LENGTH,
    TOKENS_CHECK_MAX_FRAME_CHARS,
  );
}
