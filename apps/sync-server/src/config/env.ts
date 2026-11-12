import { JOIN_METHODS, type JoinMethod } from '@sync-system/protocol';
import { z } from 'zod';
import { ConfigError } from './config-error.js';
import { collectRedisSettings } from './redis.js';
import {
  ROSTER_SNAPSHOT_HEADROOM_BYTES,
  TOKENS_CHECK_MAX_FRAME_BYTES,
  rosterSnapshotMaxBytes,
} from '../limits/constants.js';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface ServerEnv {
  configPath: string;
  port: number;
  host: string;
  logLevel: LogLevel;
  nodeEnv: string | undefined;
  /** Ceiling for app `maxGroupSize`. */
  maxGroupSizeCeiling: number;
  /** Ceiling for app `maxLeaderUpdatesPerSecond`. */
  maxLeaderUpdateRateCeiling: number;
  /** Ceiling for app `maxMessageBytes`. */
  maxMessageSizeCeiling: number;
  /** Ceiling for app `maxConnections` (M5). */
  maxAppConnectionsCeiling: number;
  /** Global concurrent WebSocket cap, pending and authenticated (H1). */
  maxConnections: number;
  /** Concurrent sockets that have not completed the handshake (H1). */
  maxPendingHandshakes: number;
  /** Per-connection inbound token refill rate (H3). */
  maxInboundMessagesPerSecond: number;
  /** Per-connection inbound bucket size (H3). */
  maxInboundBurst: number;
  /** Per-socket outbound buffer limit before terminate (H2). */
  maxBufferedBytes: number;
  /** Ceiling for app `maxSessionMinutes` (#5 AC4). */
  maxSessionMinutesCeiling: number;
  /** Ceiling for app `inactivityLimitMinutes` (#5 AC4). */
  inactivityLimitMinutesCeiling: number;
  /** Leader activities that allow a token refresh after the min interval (#5 AC12). */
  tokenRefreshActivities: number;
  /** Minimum seconds between leader token refreshes (#5 AC12). */
  tokenRefreshMinSeconds: number;
  /** Maximum seconds between leader token refreshes; also the recovery slack (#5 AC12, Q10). */
  tokenRefreshMaxSeconds: number;
  /** Join methods any app may use, in canonical order (#10 AC1). */
  joinMethodsAllowed: readonly JoinMethod[];
  /** Ceiling for app `qrTicketSeconds` (#10 AC3). */
  qrTicketSecondsCeiling: number;
  /** Ceiling for app `approvalTimeoutSeconds` (#10 AC3). */
  approvalTimeoutSecondsCeiling: number;
  /** Ceiling for app `disconnectGraceSeconds` (#13 AC1). */
  disconnectGraceSecondsCeiling: number;
  /** Ceiling for app `keepAliveCountdownSeconds` (#13 AC1). */
  keepAliveCountdownSecondsCeiling: number;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

interface NumericVar {
  key: keyof ServerEnv;
  name: string;
  defaultValue: number;
  /** Lower bound; defaults to 1. */
  min?: number;
  max?: number;
}

const NUMERIC_VARS: readonly NumericVar[] = [
  { key: 'port', name: 'PORT', defaultValue: 8080, max: 65535 },
  { key: 'maxGroupSizeCeiling', name: 'MAX_GROUP_SIZE_CEILING', defaultValue: 100 },
  { key: 'maxLeaderUpdateRateCeiling', name: 'MAX_LEADER_UPDATE_RATE_CEILING', defaultValue: 10 },
  { key: 'maxMessageSizeCeiling', name: 'MAX_MESSAGE_SIZE_CEILING', defaultValue: 16384 },
  { key: 'maxAppConnectionsCeiling', name: 'MAX_APP_CONNECTIONS_CEILING', defaultValue: 10000 },
  { key: 'maxConnections', name: 'MAX_CONNECTIONS', defaultValue: 10000 },
  { key: 'maxPendingHandshakes', name: 'MAX_PENDING_HANDSHAKES', defaultValue: 1000 },
  {
    key: 'maxInboundMessagesPerSecond',
    name: 'MAX_INBOUND_MESSAGES_PER_SECOND',
    defaultValue: 20,
  },
  { key: 'maxInboundBurst', name: 'MAX_INBOUND_BURST', defaultValue: 40 },
  { key: 'maxBufferedBytes', name: 'MAX_BUFFERED_BYTES', defaultValue: 262_144 },
  { key: 'maxSessionMinutesCeiling', name: 'MAX_SESSION_MINUTES_CEILING', defaultValue: 480 },
  {
    key: 'inactivityLimitMinutesCeiling',
    name: 'INACTIVITY_LIMIT_MINUTES_CEILING',
    defaultValue: 60,
  },
  { key: 'tokenRefreshActivities', name: 'TOKEN_REFRESH_ACTIVITIES', defaultValue: 10 },
  { key: 'tokenRefreshMinSeconds', name: 'TOKEN_REFRESH_MIN_SECONDS', defaultValue: 60 },
  {
    key: 'tokenRefreshMaxSeconds',
    name: 'TOKEN_REFRESH_MAX_SECONDS',
    defaultValue: 300,
    max: 3600,
  },
  // The bounds keep min(app default, ceiling) above each app field's minimum,
  // and match the client's hello.ok bounds (#10 architecture 5.1).
  {
    key: 'qrTicketSecondsCeiling',
    name: 'QR_TICKET_SECONDS_CEILING',
    defaultValue: 3600,
    min: 30,
    max: 86_400,
  },
  {
    key: 'approvalTimeoutSecondsCeiling',
    name: 'APPROVAL_TIMEOUT_SECONDS_CEILING',
    defaultValue: 600,
    min: 15,
    max: 3600,
  },
  // #13 AC1: timers of the group lifecycle.
  {
    key: 'disconnectGraceSecondsCeiling',
    name: 'DISCONNECT_GRACE_SECONDS_CEILING',
    defaultValue: 120,
    max: 3600,
  },
  {
    key: 'keepAliveCountdownSecondsCeiling',
    name: 'KEEP_ALIVE_COUNTDOWN_SECONDS_CEILING',
    defaultValue: 120,
    max: 3600,
  },
];

const JOIN_METHODS_ERROR =
  'JOIN_METHODS_ALLOWED must be a non-empty comma-separated list of distinct methods A, B, C, D';

/**
 * Parses JOIN_METHODS_ALLOWED (#10 AC1): comma-separated uppercase letters
 * A-D, whitespace around items trimmed. Returns the canonical order, or
 * undefined for an empty list, an unknown letter or a duplicate.
 */
export function parseJoinMethodsAllowed(raw: string): JoinMethod[] | undefined {
  const items = raw.split(',').map((item) => item.trim());
  const known: readonly string[] = JOIN_METHODS;
  if (items.some((item) => !known.includes(item))) return undefined;
  if (new Set(items).size !== items.length) return undefined;
  return JOIN_METHODS.filter((method) => items.includes(method));
}

/** Digits only, no sign, no leading zero, no decimal point. */
const positiveIntegerText = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .refine((n) => Number.isSafeInteger(n));

const logLevelSchema = z.enum(LOG_LEVELS);

/**
 * Parses and validates the server's env variables. Unset means the default.
 * Every problem is collected and reported together in one ConfigError, which
 * names the variables involved. Raw values are never echoed.
 */
export function parseEnv(env: EnvSource): ServerEnv {
  const errors: string[] = [];
  const numbers: Partial<Record<keyof ServerEnv, number>> = {};

  for (const variable of NUMERIC_VARS) {
    const raw = env[variable.name];
    if (raw === undefined) {
      numbers[variable.key] = variable.defaultValue;
      continue;
    }
    const parsed = positiveIntegerText.safeParse(raw);
    if (!parsed.success) {
      errors.push(`${variable.name} must be a positive integer`);
      continue;
    }
    const min = variable.min ?? 1;
    const max = variable.max ?? Number.MAX_SAFE_INTEGER;
    if (parsed.data < min || parsed.data > max) {
      errors.push(`${variable.name} must be between ${min} and ${max}`);
      continue;
    }
    numbers[variable.key] = parsed.data;
  }

  let logLevel: LogLevel = 'info';
  if (env.LOG_LEVEL !== undefined) {
    const parsed = logLevelSchema.safeParse(env.LOG_LEVEL);
    if (parsed.success) {
      logLevel = parsed.data;
    } else {
      errors.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
    }
  }

  const host = env.HOST ?? '0.0.0.0';
  if (host.trim() === '') errors.push('HOST must not be empty');

  let joinMethodsAllowed: readonly JoinMethod[] = JOIN_METHODS;
  if (env.JOIN_METHODS_ALLOWED !== undefined) {
    const parsed = parseJoinMethodsAllowed(env.JOIN_METHODS_ALLOWED);
    if (parsed === undefined) {
      // The value is never echoed.
      errors.push(JOIN_METHODS_ERROR);
    } else {
      joinMethodsAllowed = parsed;
    }
  }

  const configPath = env.SYNC_CONFIG_PATH ?? './config/apps.json';
  if (configPath.trim() === '') errors.push('SYNC_CONFIG_PATH must not be empty');

  // REDIS_* problems are reported with the rest (#35 AC3). The settings
  // themselves are built by parseRedisSettings and never kept in ServerEnv.
  collectRedisSettings(env, errors);

  if (errors.length === 0) {
    const n = numbers as Record<keyof ServerEnv, number>;
    const rule = (ok: boolean, message: string) => {
      if (!ok) errors.push(message);
    };
    rule(
      n.maxAppConnectionsCeiling <= n.maxConnections,
      `MAX_APP_CONNECTIONS_CEILING (${n.maxAppConnectionsCeiling}) must be <= MAX_CONNECTIONS (${n.maxConnections})`,
    );
    rule(
      n.maxPendingHandshakes <= n.maxConnections,
      `MAX_PENDING_HANDSHAKES (${n.maxPendingHandshakes}) must be <= MAX_CONNECTIONS (${n.maxConnections})`,
    );
    rule(
      n.maxInboundMessagesPerSecond > n.maxLeaderUpdateRateCeiling,
      `MAX_INBOUND_MESSAGES_PER_SECOND (${n.maxInboundMessagesPerSecond}) must be > MAX_LEADER_UPDATE_RATE_CEILING (${n.maxLeaderUpdateRateCeiling})`,
    );
    rule(
      n.maxInboundBurst >= n.maxInboundMessagesPerSecond,
      `MAX_INBOUND_BURST (${n.maxInboundBurst}) must be >= MAX_INBOUND_MESSAGES_PER_SECOND (${n.maxInboundMessagesPerSecond})`,
    );
    rule(
      n.maxBufferedBytes >= 4 * n.maxMessageSizeCeiling,
      `MAX_BUFFERED_BYTES (${n.maxBufferedBytes}) must be >= 4 * MAX_MESSAGE_SIZE_CEILING (${4 * n.maxMessageSizeCeiling})`,
    );
    // A tokens.result with the most re-signed tokens (secret rotation) must fit
    // in an empty outbound buffer, or sending it terminates the socket (#5).
    rule(
      n.maxBufferedBytes >= TOKENS_CHECK_MAX_FRAME_BYTES,
      `MAX_BUFFERED_BYTES (${n.maxBufferedBytes}) must be >= the largest tokens.result frame (${TOKENS_CHECK_MAX_FRAME_BYTES})`,
    );
    // A roster snapshot of the largest group, with the frames right behind
    // it, must fit an empty outbound buffer (#13 5.5).
    const rosterBytes =
      rosterSnapshotMaxBytes(n.maxGroupSizeCeiling) + ROSTER_SNAPSHOT_HEADROOM_BYTES;
    rule(
      n.maxBufferedBytes >= rosterBytes,
      `MAX_BUFFERED_BYTES (${n.maxBufferedBytes}) must be >= the largest roster snapshot plus headroom (${rosterBytes}) for MAX_GROUP_SIZE_CEILING (${n.maxGroupSizeCeiling})`,
    );
    rule(
      n.tokenRefreshMinSeconds <= n.tokenRefreshMaxSeconds,
      `TOKEN_REFRESH_MIN_SECONDS (${n.tokenRefreshMinSeconds}) must be <= TOKEN_REFRESH_MAX_SECONDS (${n.tokenRefreshMaxSeconds})`,
    );
  }

  if (errors.length > 0) {
    throw new ConfigError(errors.join('\n'));
  }

  const n = numbers as Record<keyof ServerEnv, number>;
  return {
    configPath,
    port: n.port,
    host,
    logLevel,
    nodeEnv: env.NODE_ENV,
    maxGroupSizeCeiling: n.maxGroupSizeCeiling,
    maxLeaderUpdateRateCeiling: n.maxLeaderUpdateRateCeiling,
    maxMessageSizeCeiling: n.maxMessageSizeCeiling,
    maxAppConnectionsCeiling: n.maxAppConnectionsCeiling,
    maxConnections: n.maxConnections,
    maxPendingHandshakes: n.maxPendingHandshakes,
    maxInboundMessagesPerSecond: n.maxInboundMessagesPerSecond,
    maxInboundBurst: n.maxInboundBurst,
    maxBufferedBytes: n.maxBufferedBytes,
    maxSessionMinutesCeiling: n.maxSessionMinutesCeiling,
    inactivityLimitMinutesCeiling: n.inactivityLimitMinutesCeiling,
    tokenRefreshActivities: n.tokenRefreshActivities,
    tokenRefreshMinSeconds: n.tokenRefreshMinSeconds,
    tokenRefreshMaxSeconds: n.tokenRefreshMaxSeconds,
    joinMethodsAllowed: Object.freeze([...joinMethodsAllowed]),
    qrTicketSecondsCeiling: n.qrTicketSecondsCeiling,
    approvalTimeoutSecondsCeiling: n.approvalTimeoutSecondsCeiling,
    disconnectGraceSecondsCeiling: n.disconnectGraceSecondsCeiling,
    keepAliveCountdownSecondsCeiling: n.keepAliveCountdownSecondsCeiling,
  };
}
