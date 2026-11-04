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
 * Room in a group.resume frame for a full block list (256 IDs of about 39
 * bytes each), a 2048-character token and slack (#5 architecture 4.6).
 */
export const RECOVERY_EXTRA_BYTES = 16_384;

/**
 * A tokens.check frame with 20 tokens of 2048 characters plus the envelope.
 * Also bounds the tokens.result reply (20 re-signed tokens during secret
 * rotation), so MAX_BUFFERED_BYTES must be at least this large (#5).
 */
export const TOKENS_CHECK_MAX_FRAME_BYTES = 45_056;

/**
 * Transport frame limit: large enough that any frame that could still be legal
 * reaches the app-level size check, small enough to bound memory. A
 * group.resume carries metadata and a position (each up to the ceiling), a
 * token and a block list, which has its own count limit and is not counted
 * against the app's max message size (#5 AC24).
 */
export function transportMaxPayload(maxMessageSizeCeiling: number): number {
  return Math.max(
    2 * maxMessageSizeCeiling + 8192 + RECOVERY_EXTRA_BYTES,
    TOKENS_CHECK_MAX_FRAME_BYTES,
  );
}

/**
 * Cap on queued inbound bytes per connection, as a multiple of the transport
 * frame limit, next to the MAX_QUEUED_MESSAGES count cap (#7 L3, D2). Fixed,
 * not configurable.
 */
export const INBOUND_QUEUE_PAYLOAD_FACTOR = 4;

/** Most bytes of inbound frames queued but not yet handled on one connection. */
export function maxQueuedInboundBytes(maxMessageSizeCeiling: number): number {
  return INBOUND_QUEUE_PAYLOAD_FACTOR * transportMaxPayload(maxMessageSizeCeiling);
}

/** Token lifetime: `exp = iat + TOKEN_TTL_SECONDS` (365 days, #5 AC5). */
export const TOKEN_TTL_SECONDS = 365 * 86_400;

/** Clock skew tolerated for token times in the future (M2). */
export const MAX_CLOCK_SKEW_MS = 300_000;

/** Most remembered ended-group refs; the oldest is evicted first (Q8, L4). */
export const MAX_ENDED_GROUPS = 100_000;

/**
 * Group recreations (a `group.resume` that rebuilds a group after a restart)
 * per connection per window (#13 RC20, M5): slows a stock-up of recreated
 * and ended groups that would fill the ended-groups memory. Same size as the
 * join-attempt budget.
 */
export const RECREATIONS_PER_CONNECTION_PER_MINUTE = 10;

/** Window of the recreation limiter. */
export const RECREATION_WINDOW_MS = 60_000;

/**
 * Largest serialized roster entry (#13 5.5): a participant ID, a name of 32
 * code points of up to 4 UTF-8 bytes each, the flags, a guest number and the
 * keys, with slack.
 */
export const ROSTER_ENTRY_MAX_BYTES = 320;

/**
 * Largest `roster.snapshot` for a group size ceiling (#13 5.5): twice the
 * group size plus the two protected entries (D10), plus the envelope.
 */
export function rosterSnapshotMaxBytes(maxGroupSizeCeiling: number): number {
  return 256 + (2 * maxGroupSizeCeiling + 2) * ROSTER_ENTRY_MAX_BYTES;
}

/** Room next to a roster snapshot in an empty outbound buffer (#13 5.5). */
export const ROSTER_SNAPSHOT_HEADROOM_BYTES = 32_768;

/** Window of the per-group leader control limiters (#13 8.2). */
export const LEADER_CONTROL_WINDOW_MS = 60_000;

/**
 * leader.activity and keepalive.ack per group per window, shared (#13 8.2,
 * Q-E). The first keepalive.ack of an outstanding prompt is never charged
 * (L5), so a spent budget cannot make the real answer fail.
 */
export const LEADER_ACTIVITY_PER_GROUP_PER_MINUTE = 12;

/** member.remove per group per window (#13 8.2, Q-E). */
export const MEMBER_REMOVALS_PER_GROUP_PER_MINUTE = 10;

/** group.lock and group.unlock per group per window (#13 8.2, Q-E). */
export const LOCK_CHANGES_PER_GROUP_PER_MINUTE = 10;

/** vice.set and vice.clear per group per window (#13 8.2, Q-E). */
export const VICE_CHANGES_PER_GROUP_PER_MINUTE = 10;

/** How often expired ended-group refs are swept. */
export const ENDED_SWEEP_MS = 60_000;

/** tokens.check requests per connection per window (#5 AC16). */
export const TOKENS_CHECK_PER_MINUTE = 10;

/** Window of the tokens.check limiter. */
export const TOKENS_CHECK_WINDOW_MS = 60_000;

/**
 * tokens.check requests per app per window, shared by every connection of
 * the app, on top of the per-connection limit (#7 L2, D1). Fixed, not
 * configurable; there is no global budget.
 */
export const TOKENS_CHECK_PER_APP_PER_MINUTE = 600;

/**
 * Join attempts (`group.joinByCode` and `group.joinByQr`, any outcome) per
 * connection per window (#10 AC27, Q5.2). Fixed, not an app setting.
 */
export const JOIN_ATTEMPTS_PER_CONNECTION_PER_MINUTE = 10;

/**
 * Join attempts per app per window, shared by all of the app's connections
 * (#10 AC28, Q5.2). Fixed, not an app setting.
 */
export const JOIN_ATTEMPTS_PER_APP_PER_MINUTE = 600;

/** Window of the join attempt limiters. */
export const JOIN_WINDOW_MS = 60_000;

/**
 * Wrong door codes per app per window, over all of the app's groups (#10
 * R1b, Gate 2 Q-E). Checked before the door code is compared and charged
 * only when it is wrong. Fixed, not an app setting.
 */
export const DOOR_FAILURES_PER_APP_PER_MINUTE = 60;

/** Window of the per-app wrong door code limiter. */
export const DOOR_FAILURES_APP_WINDOW_MS = 60_000;

/**
 * Wrong door codes against one door code before it rotates (#10 AC29, R1a).
 * Counted since the last door-code change, with no time window.
 */
export const DOOR_FAILURES_BEFORE_ROTATION = 5;

/** Door rotations inside DOOR_ROTATION_WINDOW_MS that pause method A (#10 AC29). */
export const DOOR_ROTATIONS_BEFORE_PAUSE = 3;

/** Window of the door rotation count (30 minutes). */
export const DOOR_ROTATION_WINDOW_MS = 1_800_000;

/** How long method A joining pauses (10 minutes, #10 AC29). */
export const DOOR_PAUSE_MS = 600_000;

/** `qr.issue` requests per connection per window (#10 AC23). */
export const QR_ISSUE_PER_CONNECTION_PER_MINUTE = 6;

/** Window of the `qr.issue` limiter. */
export const QR_ISSUE_WINDOW_MS = 60_000;

/** Pending method B join requests per group (#10 AC22). */
export const MAX_PENDING_APPROVALS_PER_GROUP = 10;

/** Leader `codes.rotate` requests per group per window (#10 AC30). */
export const CODE_ROTATIONS_PER_GROUP_PER_MINUTE = 6;

/** Window of the `codes.rotate` limiter. */
export const CODE_ROTATION_WINDOW_MS = 60_000;

/**
 * Most draws of one join code before giving up with CODES_EXHAUSTED (#10
 * AC9). Each draw is checked against the app's live codes.
 */
export const MAX_CODE_DRAWS = 20;
