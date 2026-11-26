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

/**
 * Where the current token secret came from: the env, a file
 * (`TOKEN_SECRET_FILE`, #58), the public dev secret, or a random per-process
 * secret (tokens do not survive a restart).
 */
export type TokenSecretSource = 'env' | 'file' | 'dev' | 'random';

/**
 * Secrets a library caller (or a test) supplies itself. Bytes go in here;
 * the server turns them into a `TokenSecrets` handle with
 * `redactTokenSecrets` and never gives them back out.
 */
export interface TokenSecretsInput {
  /** Signs and verifies. */
  readonly current: Buffer;
  /** Verifies only (rotation, AC2). */
  readonly previous?: Buffer;
  readonly source: TokenSecretSource;
}

/** The raw bytes of a `TokenSecrets`, for `TokenKeyring` only. */
export interface TokenSecretBytes {
  readonly current: Buffer;
  readonly previous: Buffer | undefined;
}

const REDACTED = '[redacted token secrets]';

/** Set once by the static block of `TokenSecrets`; reads its private fields. */
let readSecretBytes: (secrets: TokenSecrets) => TokenSecretBytes;

/**
 * The token secrets as the server holds them: an opaque, frozen handle (#58
 * security C7, Gate 3 round 3). The bytes live in private fields, copied
 * from the input, so no property, spread, `Object.values`, JSON, inspect or
 * string conversion reaches them, and there is no byte accessor on the
 * object. Only `tokenSecretBytes` (imported by `tokens/token-keys.ts` alone,
 * `test/token-secret-readers.test.ts`) reads them, as HKDF input. The
 * private fields also make the type nominal: a plain object is never a
 * `TokenSecrets`.
 */
export class TokenSecrets {
  readonly #current: Buffer;
  readonly #previous: Buffer | undefined;
  readonly source: TokenSecretSource;

  static {
    readSecretBytes = (secrets) => ({ current: secrets.#current, previous: secrets.#previous });
  }

  /** Copies `current` and `previous`; the caller's Buffers are never kept or changed. */
  constructor(current: Buffer, previous: Buffer | undefined, source: TokenSecretSource) {
    this.#current = Buffer.from(current);
    this.#previous = previous === undefined ? undefined : Buffer.from(previous);
    this.source = source;
    Object.freeze(this);
  }

  /** Whether a previous secret (rotation) is set; never its value. */
  get hasPrevious(): boolean {
    return this.#previous !== undefined;
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
 * The raw bytes of `secrets`. Internal to the server: `tokens/token-keys.ts`
 * is the only module allowed to import it (static check in
 * `test/token-secret-readers.test.ts`), and it is not exported from the
 * package entry point. Throws a TypeError for anything that is not a
 * `TokenSecrets` built by this module.
 */
export function tokenSecretBytes(secrets: TokenSecrets): TokenSecretBytes {
  return readSecretBytes(secrets);
}

/**
 * `secrets` as a `TokenSecrets` handle: returned as is when it already is
 * one, otherwise built from a copy of the caller's Buffers (the caller's
 * object and Buffers are not changed). This is the constructor path for
 * library callers who supply their own secrets; `createSyncServer` passes
 * what it is given through it (#58 security C7).
 */
export function redactTokenSecrets(secrets: TokenSecrets | TokenSecretsInput): TokenSecrets {
  if (secrets instanceof TokenSecrets) return secrets;
  return new TokenSecrets(secrets.current, secrets.previous, secrets.source);
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

  let source: TokenSecretSource | undefined;
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

  return new TokenSecrets(
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
  if (secrets.hasPrevious) {
    logger.warn(
      { event: 'token_secret_previous_set' },
      'TOKEN_SECRET_PREVIOUS is set: remove it after the rotation window',
    );
  }
}
