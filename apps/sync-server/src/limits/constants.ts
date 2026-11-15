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

/** leader.takeBack per group per window (#13 8.2, Q-E): caps a take-back ping-pong. */
export const TAKE_BACKS_PER_GROUP_PER_MINUTE = 3;

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

/**
 * Slack after a group's max-session deadline before Redis drops its keys
 * (#35 AC24, Gate 2 Q-A2): the max-session timer can still read the group,
 * tell its participants and record the end.
 */
export const END_TTL_SLACK_MS = 5_000;

/** Redis connection errors are logged at most once per this window (#35 AC25). */
export const REDIS_ERROR_LOG_INTERVAL_MS = 30_000;

/** While Redis is unreachable, a PING probe runs this often (#35 security C4). */
export const REDIS_PROBE_INTERVAL_MS = 1_000;

/** Longest wait between Redis reconnect attempts (#35 architecture 3). */
export const REDIS_RECONNECT_MAX_MS = 5_000;

/** Safety poll of the Redis timer due set (#35 ADR 0013). */
export const TIMER_POLL_MS = 1_000;

/** How long a claimed Redis timer is leased to the claiming instance (#35 ADR 0013). */
export const TIMER_LEASE_MS = 30_000;

/**
 * How long an instance's liveness key lives after each renewal (#35
 * architecture 12.5, Gate 2 Q-B5). Peers treat an instance as dead only
 * once this key is gone (Redis time).
 */
export const INSTANCE_LIVENESS_MS = 15_000;

/** How often an instance renews its liveness key (#35 architecture 12.5). */
export const INSTANCE_HEARTBEAT_MS = 5_000;

/**
 * An instance whose last successful renewal was sent this long ago fences
 * itself: it closes its group sessions before peers may sweep it (#35
 * security P2-3). Below INSTANCE_LIVENESS_MS, so the margin is 5 s.
 */
export const INSTANCE_SELF_FENCE_MS = 10_000;

/**
 * A group task's Redis lease (#35 architecture 12.4, ADR 0011, Gate 2
 * Q-B5): it lives this long after each renewal, so a crashed holder blocks
 * the group at most this long.
 */
export const GROUP_LEASE_MS = 10_000;

/** How often a running task renews its group lease. */
export const GROUP_LEASE_RENEW_MS = 3_000;

/**
 * Renewals stop after this long (#35 architecture 12.4): a task that holds
 * a lease this long is a bug, and the commit fence then refuses its write.
 */
export const GROUP_LEASE_MAX_HOLD_MS = 30_000;

/**
 * How long a task waits for a group lease held by another instance before
 * it fails as busy: only the requester's connection closes with 1001 (#35
 * Gate 2 Q-B4, security P2-7).
 */
export const GROUP_LOCK_WAIT_MS = 5_000;

/**
 * How often an instance looks for stopped or dead instances and sweeps
 * their attachments (#35 architecture 12.8), with up to 1 s of jitter.
 */
export const ORPHAN_SWEEP_MS = 5_000;

/**
 * Largest pub/sub message between instances (#35 architecture 12.7): a
 * received one over it is dropped before parsing; a commit splits its
 * effects for one instance into several ordered messages under it.
 */
export const PUBSUB_MESSAGE_MAX_BYTES = 1_048_576;

/** Longest serialized frame inside a remote effect (a roster snapshot is about 45 KB). */
export const PUBSUB_FRAME_MAX_CHARS = 131_072;

/** Most effects in one pub/sub message. */
export const PUBSUB_EFFECTS_MAX = 512;

/**
 * How long a task waits for the effects an earlier commit of its group
 * published to this instance (#35 Gate 2 Q-B10) before it treats the
 * subscriber link as stalled.
 */
export const PUBSUB_BARRIER_MS = 1_000;

/**
 * A received sequence this far (1 s of Redis time, in microseconds) or more
 * below the last one is not a stale message but a sequence that went back
 * (`P:seq` lost while Redis time is behind, or a forged `s`): the link is
 * treated as lost and restarts from the current sequence (#35 security S1).
 * A smaller step back is dropped as stale.
 */
export const PUBSUB_SEQUENCE_REWIND_MAX = 1_000_000;

/** How long the instance list keeps an instance ID after its last registration (24 h). */
export const INSTANCE_LIST_RETENTION_MS = 86_400_000;
