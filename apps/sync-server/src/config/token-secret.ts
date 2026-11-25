import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { ConfigError } from './config-error.js';
import { DEV_KEY_NODE_ENVS } from './dev-key.js';
import type { EnvSource } from './env.js';
import { resolveSecret } from './secret-file.js';

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
   * Where `current` came from: the env, a file (`TOKEN_SECRET_FILE`, #58),
   * the public dev secret, or a random per-process secret (tokens do not
   * survive a restart).
   */
  readonly source: 'env' | 'file' | 'dev' | 'random';
}

const REDACTED = '[redacted token secrets]';
const REDACTED_SECRET = '[redacted token secret]';

/**
 * A copy of `bytes` whose JSON, inspect and string conversion (`String()`,
 * template literals) return a fixed marker, so a secret Buffer copied out of
 * its `TokenSecrets` (for example by `{ ...secrets }`) still logs no byte
 * (#58 security C7). An explicit `toString(encoding)` still decodes the
 * bytes. The caller's Buffer is never changed.
 */
function redactedSecretBuffer(bytes: Buffer): Buffer {
  const copy = Buffer.from(bytes);
  const marker = { value: () => REDACTED_SECRET, enumerable: false };
  Object.defineProperties(copy, {
    toJSON: marker,
    [Symbol.toPrimitive]: marker,
    [inspect.custom]: marker,
  });
  return copy;
}

/**
 * The secrets as handed to the rest of the server: frozen, and `toJSON`,
 * `toString` and `inspect` return a fixed marker (prototype methods, so they
 * survive as long as the object does and never show as fields). The Buffers
 * are redacted too, so a copy of the object (spread, `Object.assign`) logs
 * no byte of a secret either (#58 security C7). The Buffers stay readable
 * for `TokenKeyring`.
 */
class RedactedTokenSecrets implements TokenSecrets {
  readonly current: Buffer;
  declare readonly previous?: Buffer;
  readonly source: TokenSecrets['source'];

  constructor(current: Buffer, previous: Buffer | undefined, source: TokenSecrets['source']) {
    this.current = redactedSecretBuffer(current);
    // An own field only when set, like the object literal this replaces.
    if (previous !== undefined) {
      Object.defineProperty(this, 'previous', {
        value: redactedSecretBuffer(previous),
        enumerable: true,
      });
    }
    this.source = source;
    Object.freeze(this);
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

/**
 * `secrets` in the redacted form: returned as is when it already is one,
 * otherwise copied (the caller's object and Buffers are not changed).
 * `createSyncServer` passes secrets a library caller built itself through
 * this (#58 security C7).
 */
export function redactTokenSecrets(secrets: TokenSecrets): TokenSecrets {
  if (secrets instanceof RedactedTokenSecrets) return secrets;
  return new RedactedTokenSecrets(secrets.current, secrets.previous, secrets.source);
}

const GENERATE_HINT = 'use `openssl rand -base64 32`';

function isDevEnvironment(nodeEnv: string | undefined): boolean {
  return nodeEnv !== undefined && DEV_KEY_NODE_ENVS.includes(nodeEnv);
}

/**
 * Checks one set secret. Messages name the variable and the rule, never the
 * value. The secret is used exactly as given: it is never trimmed, so leading
 * or trailing whitespace is an error rather than a silent difference between
 * instances (M3). `name` is the label of the source: `TOKEN_SECRET` or
 * `TOKEN_SECRET (from TOKEN_SECRET_FILE)` (#58).
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
 * Reads TOKEN_SECRET and TOKEN_SECRET_PREVIOUS (architecture 5.1, R4), each
 * from the environment or from the file named by its `_FILE` twin (#58,
 * ADR 0023):
 * - a missing TOKEN_SECRET is allowed only when NODE_ENV is exactly
 *   `development` or `test` (a random per-process secret is used); anywhere
 *   else it is an error (fail closed, Q-A);
 * - a set secret must be at least 32 bytes with at least 16 distinct byte
 *   values, must not be a docs example, and must not be the dev secret
 *   outside development/test, in every environment, whatever its source;
 * - TOKEN_SECRET_PREVIOUS follows the same rules and must differ from
 *   TOKEN_SECRET.
 *
 * Every problem is pushed to `errors`; values are never echoed. Returns
 * undefined when any problem was found: never a random or dev fallback for a
 * secret that failed, including a `TOKEN_SECRET_FILE` that could not be read
 * (#36 security C1, #58 security C3).
 */
export function collectTokenSecrets(
  env: EnvSource,
  nodeEnv: string | undefined,
  errors: string[],
): TokenSecrets | undefined {
  const before = errors.length;
  const current = resolveSecret(env, 'TOKEN_SECRET', errors);

  let source: TokenSecrets['source'] | undefined;
  if (current.kind === 'unset') {
    if (isDevEnvironment(nodeEnv)) {
      source = 'random';
    } else {
      errors.push(`TOKEN_SECRET is required (${GENERATE_HINT})`);
    }
  } else if (current.kind === 'set') {
    source =
      checkSecret(current.label, current.value, nodeEnv, errors) === 'dev' ? 'dev' : current.from;
  }

  const previous = resolveSecret(env, 'TOKEN_SECRET_PREVIOUS', errors);
  if (previous.kind === 'set') {
    checkSecret(previous.label, previous.value, nodeEnv, errors);
    if (current.kind === 'set' && previous.value === current.value) {
      errors.push('TOKEN_SECRET_PREVIOUS must differ from TOKEN_SECRET');
    }
  }

  if (errors.length > before || source === undefined) return undefined;

  return new RedactedTokenSecrets(
    source === 'random' || current.kind !== 'set'
      ? randomBytes(MIN_TOKEN_SECRET_BYTES)
      : Buffer.from(current.value, 'utf8'),
    previous.kind === 'set' ? Buffer.from(previous.value, 'utf8') : undefined,
    source,
  );
}

/** `collectTokenSecrets` that throws one ConfigError with every problem. */
export function parseTokenSecrets(env: EnvSource, nodeEnv: string | undefined): TokenSecrets {
  const errors: string[] = [];
  const secrets = collectTokenSecrets(env, nodeEnv, errors);
  if (errors.length > 0 || secrets === undefined) throw new ConfigError(errors);
  return secrets;
}

export interface SecretWarnLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

/**
 * Startup log lines about the secrets. Never logs a value, a path or a
 * length (M1, AC3; #58 security C6): the source is one of a fixed set.
 */
export function warnAboutSecrets(secrets: TokenSecrets, logger: SecretWarnLogger): void {
  logger.info(
    { event: 'token_secret_source', source: secrets.source },
    'token secret source at startup',
  );
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
