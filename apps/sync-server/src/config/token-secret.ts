import { randomBytes } from 'node:crypto';
import { ConfigError } from './config-error.js';
import { DEV_KEY_NODE_ENVS } from './dev-key.js';
import type { EnvSource } from './env.js';

/**
 * The public development token secret. It is committed (compose.yaml), so it
 * is only accepted when NODE_ENV is exactly `development` or `test` (Q-A).
 */
export const DEV_TOKEN_SECRET = 'dev-only-insecure-token-secret-change-me-please';

/**
 * Values printed in the docs or example config. Refused in every environment
 * (M3): anyone who read the README could forge tokens with them.
 */
export const PUBLIC_EXAMPLE_SECRETS: readonly string[] = [
  'REPLACE-with-output-of-openssl-rand-base64-32',
  'REPLACE-with-a-different-openssl-rand-base64-32',
];

/** Minimum UTF-8 length of a token secret (AC1). */
export const MIN_TOKEN_SECRET_BYTES = 32;

/** Minimum number of distinct byte values; random base64 of 32 bytes has about 30 (M3). */
export const MIN_TOKEN_SECRET_DISTINCT_BYTES = 16;

export interface TokenSecrets {
  /** Signs and verifies. */
  readonly current: Buffer;
  /** Verifies only (rotation, AC2). */
  readonly previous?: Buffer;
  /**
   * Where `current` came from: the env, the public dev secret, or a random
   * per-process secret (tokens do not survive a restart).
   */
  readonly source: 'env' | 'dev' | 'random';
}

const GENERATE_HINT = 'use `openssl rand -base64 32`';

function isDevEnvironment(nodeEnv: string | undefined): boolean {
  return nodeEnv !== undefined && DEV_KEY_NODE_ENVS.includes(nodeEnv);
}

/**
 * Checks one set secret. Messages name the variable and the rule, never the
 * value. The secret is used exactly as given: it is never trimmed, so leading
 * or trailing whitespace is an error rather than a silent difference between
 * instances (M3).
 */
function checkSecret(
  name: string,
  value: string,
  nodeEnv: string | undefined,
  errors: string[],
): 'ok' | 'dev' | 'bad' {
  if (value !== value.trim()) {
    errors.push(`${name} must not start or end with whitespace`);
    return 'bad';
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length < MIN_TOKEN_SECRET_BYTES) {
    errors.push(`${name} must be at least ${MIN_TOKEN_SECRET_BYTES} bytes (${GENERATE_HINT})`);
    return 'bad';
  }
  if (PUBLIC_EXAMPLE_SECRETS.includes(value)) {
    errors.push(`${name} is an example value from the docs; ${GENERATE_HINT}`);
    return 'bad';
  }
  if (value === DEV_TOKEN_SECRET) {
    if (!isDevEnvironment(nodeEnv)) {
      errors.push(`${name} is the public development secret; ${GENERATE_HINT}`);
      return 'bad';
    }
    return 'dev';
  }
  if (new Set(bytes).size < MIN_TOKEN_SECRET_DISTINCT_BYTES) {
    errors.push(`${name} looks weak; ${GENERATE_HINT}`);
    return 'bad';
  }
  return 'ok';
}

/**
 * Reads TOKEN_SECRET and TOKEN_SECRET_PREVIOUS (architecture 5.1, R4):
 * - a missing TOKEN_SECRET is allowed only when NODE_ENV is exactly
 *   `development` or `test` (a random per-process secret is used); anywhere
 *   else it is an error (fail closed, Q-A);
 * - a set secret must be at least 32 bytes with at least 16 distinct byte
 *   values, must not be a docs example, and must not be the dev secret
 *   outside development/test, in every environment;
 * - TOKEN_SECRET_PREVIOUS follows the same rules and must differ from
 *   TOKEN_SECRET.
 *
 * Every problem is reported in one ConfigError. Values are never echoed.
 */
export function parseTokenSecrets(env: EnvSource, nodeEnv: string | undefined): TokenSecrets {
  const errors: string[] = [];
  const raw = env.TOKEN_SECRET;
  const rawPrevious = env.TOKEN_SECRET_PREVIOUS;

  let source: TokenSecrets['source'] = 'env';
  if (raw === undefined) {
    if (isDevEnvironment(nodeEnv)) {
      source = 'random';
    } else {
      errors.push(`TOKEN_SECRET is required (${GENERATE_HINT})`);
    }
  } else if (checkSecret('TOKEN_SECRET', raw, nodeEnv, errors) === 'dev') {
    source = 'dev';
  }

  if (rawPrevious !== undefined) {
    checkSecret('TOKEN_SECRET_PREVIOUS', rawPrevious, nodeEnv, errors);
    if (raw !== undefined && rawPrevious === raw) {
      errors.push('TOKEN_SECRET_PREVIOUS must differ from TOKEN_SECRET');
    }
  }

  if (errors.length > 0) throw new ConfigError(errors.join('\n'));

  const current =
    source === 'random' ? randomBytes(MIN_TOKEN_SECRET_BYTES) : Buffer.from(raw!, 'utf8');
  return rawPrevious === undefined
    ? { current, source }
    : { current, previous: Buffer.from(rawPrevious, 'utf8'), source };
}

export interface SecretWarnLogger {
  warn(obj: object, msg: string): void;
}

/** Startup warnings about the secrets. Never logs a value (M1, AC3). */
export function warnAboutSecrets(secrets: TokenSecrets, logger: SecretWarnLogger): void {
  if (secrets.source === 'random') {
    logger.warn(
      { event: 'token_secret_random' },
      'TOKEN_SECRET is not set: using a random secret; tokens will not survive a restart',
    );
  } else if (secrets.source === 'dev') {
    logger.warn({ event: 'dev_token_secret' }, 'the public development token secret is in use');
  }
  if (secrets.previous !== undefined) {
    logger.warn(
      { event: 'token_secret_previous_set' },
      'TOKEN_SECRET_PREVIOUS is set: remove it after the rotation window',
    );
  }
}
