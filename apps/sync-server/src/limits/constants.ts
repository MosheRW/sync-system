/** Fixed server limits (not configurable by env). See architecture.md section 4. */

/** A hello is one small message; sockets that do not send it are closed (H1). */
export const HANDSHAKE_TIMEOUT_MS = 5_000;

/** How long a closing socket may take to answer our close frame (S1). */
export const CLOSE_TIMEOUT_MS = 2_000;

/** Maximum queued inbound messages per connection before close 4008 (H3). */
export const MAX_QUEUED_MESSAGES = 32;

/** Interval between heartbeat pings (H2, AC17). */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** HTTP slowloris protection (H1). */
export const HTTP_HEADERS_TIMEOUT_MS = 10_000;
export const HTTP_REQUEST_TIMEOUT_MS = 15_000;

/** Extra HTTP sockets above MAX_CONNECTIONS so /health stays reachable at the WS cap (H1). */
export const HTTP_CONNECTION_MARGIN = 64;

/** Window of the leader update rate limiter. */
export const LEADER_RATE_WINDOW_MS = 1_000;

/**
 * Transport frame limit: large enough that any frame that could still be legal
 * reaches the app-level size check, small enough to bound memory.
 */
export function transportMaxPayload(maxMessageSizeCeiling: number): number {
  return 2 * maxMessageSizeCeiling + 8192;
}

/** Token lifetime: `exp = iat + TOKEN_TTL_SECONDS` (365 days, #5 AC5). */
export const TOKEN_TTL_SECONDS = 365 * 86_400;

/** Clock skew tolerated for token times in the future (M2). */
export const MAX_CLOCK_SKEW_MS = 300_000;
