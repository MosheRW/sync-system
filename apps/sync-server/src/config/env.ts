import { z } from 'zod';
import { ConfigError } from './config-error.js';

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
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

interface NumericVar {
  key: keyof ServerEnv;
  name: string;
  defaultValue: number;
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
];

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
    if (variable.max !== undefined && parsed.data > variable.max) {
      errors.push(`${variable.name} must be between 1 and ${variable.max}`);
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

  const configPath = env.SYNC_CONFIG_PATH ?? './config/apps.json';
  if (configPath.trim() === '') errors.push('SYNC_CONFIG_PATH must not be empty');

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
  };
}
