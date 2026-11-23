import { inspect } from 'node:util';
import { ConfigError } from './config-error.js';
import { DEV_KEY_NODE_ENVS } from './dev-key.js';
import type { EnvSource } from './env.js';

/**
 * The public development Redis password of `compose.redis.yaml`. It is
 * committed, so it is only accepted when NODE_ENV is exactly `development`
 * or `test`, like the dev token secret (#35 security C5).
 */
export const DEV_REDIS_PASSWORD = 'dev-only-insecure-redis-password-change-me';

export const DEFAULT_REDIS_KEY_PREFIX = 'sync';
export const DEFAULT_REDIS_CONNECT_TIMEOUT_SECONDS = 10;
export const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 2000;
/** Bounds of the two Redis timeouts (the operator guide's env table is tested against them, #37 AC45). */
export const REDIS_CONNECT_TIMEOUT_SECONDS_MIN = 1;
export const REDIS_CONNECT_TIMEOUT_SECONDS_MAX = 120;
export const REDIS_COMMAND_TIMEOUT_MS_MIN = 100;
export const REDIS_COMMAND_TIMEOUT_MS_MAX = 30000;

/** `<prefix>:v1:...`; never contains `:` (#35 AC5). */
export const REDIS_KEY_PREFIX_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const INVALID_URL = 'REDIS_URL is not a valid redis:// or rediss:// URL';

/** Where and how to connect. Only `connect.ts` reads these fields. */
export interface RedisEndpoint {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly username: string | undefined;
  readonly password: string | undefined;
  readonly database: number;
}

const REDACTED = '[redacted redis settings]';

/**
 * Redis settings from `REDIS_*` (#35 architecture 3). Kept out of
 * `ServerEnv` like the token secret: the endpoint carries a password.
 * `toJSON` and `inspect` return a fixed marker, so logging the object by
 * mistake shows nothing (security C9).
 */
export class RedisSettings {
  readonly #endpoint: RedisEndpoint;

  constructor(
    endpoint: RedisEndpoint,
    readonly keyPrefix: string,
    readonly connectTimeoutMs: number,
    readonly commandTimeoutMs: number,
  ) {
    this.#endpoint = Object.freeze({ ...endpoint });
  }

  /** The connection endpoint, for `connect.ts` only. Never log it. */
  endpoint(): RedisEndpoint {
    return this.#endpoint;
  }

  /** Whether the URL has a password (the `redis_no_password` warning). */
  get hasPassword(): boolean {
    return this.#endpoint.password !== undefined && this.#endpoint.password !== '';
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

/** Digits only, no sign, no leading zero. */
function integerIn(raw: string, min: number, max: number): number | undefined {
  if (!/^[1-9][0-9]*$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

function decode(part: string): string | undefined {
  try {
    return decodeURIComponent(part);
  } catch {
    return undefined;
  }
}

/**
 * Parses REDIS_URL. Every message names the variable only, never the value,
 * host, user or password (AC3, security C9); the `new URL` error (whose
 * `input` holds the raw value) is discarded.
 */
function parseUrl(
  raw: string,
  nodeEnv: string | undefined,
  errors: string[],
): RedisEndpoint | undefined {
  if (raw === '') {
    errors.push('REDIS_URL must not be empty');
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    errors.push(INVALID_URL);
    return undefined;
  }
  if ((url.protocol !== 'redis:' && url.protocol !== 'rediss:') || url.hostname === '') {
    errors.push(INVALID_URL);
    return undefined;
  }
  if (url.search !== '' || url.hash !== '' || raw.includes('?') || raw.includes('#')) {
    errors.push('REDIS_URL must not have a query string or fragment');
    return undefined;
  }
  let port = 6379;
  if (url.port !== '') {
    const parsed = integerIn(url.port, 1, 65535);
    if (parsed === undefined) {
      errors.push('REDIS_URL port must be between 1 and 65535');
      return undefined;
    }
    port = parsed;
  }
  let database = 0;
  if (url.pathname !== '' && url.pathname !== '/') {
    const db = url.pathname.slice(1);
    const parsed = db === '0' ? 0 : integerIn(db, 1, 15);
    if (parsed === undefined) {
      errors.push('REDIS_URL database must be a number from 0 to 15');
      return undefined;
    }
    database = parsed;
  }
  const username = url.username === '' ? undefined : decode(url.username);
  const password = url.password === '' ? undefined : decode(url.password);
  if (
    (url.username !== '' && username === undefined) ||
    (url.password !== '' && password === undefined)
  ) {
    errors.push(INVALID_URL);
    return undefined;
  }
  if (
    password === DEV_REDIS_PASSWORD &&
    (nodeEnv === undefined || !DEV_KEY_NODE_ENVS.includes(nodeEnv))
  ) {
    errors.push(
      'REDIS_URL uses the public development Redis password; it is only accepted when NODE_ENV is development or test',
    );
    return undefined;
  }
  // IPv6 literals come bracketed from URL; the socket wants them bare.
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return { host, port, tls: url.protocol === 'rediss:', username, password, database };
}

/**
 * Checks every `REDIS_*` variable and returns the settings, or undefined
 * when REDIS_URL is unset (memory store). Problems are pushed to `errors`
 * so they are reported with every other config problem (AC3). The prefix
 * and timeouts are checked even without REDIS_URL, so a typo shows before
 * Redis is turned on.
 */
export function collectRedisSettings(env: EnvSource, errors: string[]): RedisSettings | undefined {
  const before = errors.length;
  let keyPrefix = DEFAULT_REDIS_KEY_PREFIX;
  if (env.REDIS_KEY_PREFIX !== undefined) {
    if (REDIS_KEY_PREFIX_PATTERN.test(env.REDIS_KEY_PREFIX)) {
      keyPrefix = env.REDIS_KEY_PREFIX;
    } else {
      errors.push(
        'REDIS_KEY_PREFIX must be 1-32 characters of a-z, 0-9, _ and -, starting with a letter or digit',
      );
    }
  }
  let connectSeconds = DEFAULT_REDIS_CONNECT_TIMEOUT_SECONDS;
  if (env.REDIS_CONNECT_TIMEOUT_SECONDS !== undefined) {
    const parsed = integerIn(
      env.REDIS_CONNECT_TIMEOUT_SECONDS,
      REDIS_CONNECT_TIMEOUT_SECONDS_MIN,
      REDIS_CONNECT_TIMEOUT_SECONDS_MAX,
    );
    if (parsed === undefined) {
      errors.push(
        `REDIS_CONNECT_TIMEOUT_SECONDS must be an integer between ${REDIS_CONNECT_TIMEOUT_SECONDS_MIN} and ${REDIS_CONNECT_TIMEOUT_SECONDS_MAX}`,
      );
    } else {
      connectSeconds = parsed;
    }
  }
  let commandMs = DEFAULT_REDIS_COMMAND_TIMEOUT_MS;
  if (env.REDIS_COMMAND_TIMEOUT_MS !== undefined) {
    const parsed = integerIn(
      env.REDIS_COMMAND_TIMEOUT_MS,
      REDIS_COMMAND_TIMEOUT_MS_MIN,
      REDIS_COMMAND_TIMEOUT_MS_MAX,
    );
    if (parsed === undefined) {
      errors.push(
        `REDIS_COMMAND_TIMEOUT_MS must be an integer between ${REDIS_COMMAND_TIMEOUT_MS_MIN} and ${REDIS_COMMAND_TIMEOUT_MS_MAX}`,
      );
    } else {
      commandMs = parsed;
    }
  }
  if (env.REDIS_URL === undefined) return undefined;
  const endpoint = parseUrl(env.REDIS_URL, env.NODE_ENV, errors);
  // Never settings built from a default after a problem (#36 security C1).
  if (endpoint === undefined || errors.length > before) return undefined;
  return new RedisSettings(endpoint, keyPrefix, connectSeconds * 1000, commandMs);
}

/**
 * The Redis settings, or undefined for the memory store. Throws one
 * ConfigError with every `REDIS_*` problem. `parseEnv` reports the same
 * problems together with the others, so after it passed this cannot throw.
 */
export function parseRedisSettings(env: EnvSource): RedisSettings | undefined {
  const errors: string[] = [];
  const settings = collectRedisSettings(env, errors);
  if (errors.length > 0) throw new ConfigError(errors);
  return settings;
}
