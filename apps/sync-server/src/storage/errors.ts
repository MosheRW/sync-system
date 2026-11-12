/**
 * Redis is unreachable or temporarily unable to serve (#35 AC26, ADR 0014):
 * a connection error, a command timeout, or one of the transient replies
 * `LOADING`, `READONLY`, `MASTERDOWN`, `BUSY`, `OOM`, `TRYAGAIN`. Nothing of
 * the failed step was stored. The affected sessions are closed with `1001`
 * (going away / temporarily unavailable), so clients resume later. Never
 * carries a host, key or value.
 */
export class StorageUnavailableError extends Error {
  constructor() {
    super('storage unavailable');
    this.name = 'StorageUnavailableError';
  }
}

/**
 * Any other Redis reply error (a script error, `WRONGTYPE`, a bug): it is
 * `INTERNAL_ERROR` to the requester only and never closes other sessions
 * (#35 security C8). Carries the reply's first word only, never its text.
 */
export class StorageReplyError extends Error {
  constructor(readonly code: string) {
    super('storage reply error');
    this.name = 'StorageReplyError';
  }
}

/** A stored value failed its schema (#35 architecture 4.3, security C1). */
export class StorageInvalidError extends Error {
  constructor() {
    super('stored value invalid');
    this.name = 'StorageInvalidError';
  }
}

/**
 * A commit's precondition was false (security C7), e.g. a recreation found
 * the group stored, ended or the epoch moved: nothing was written.
 */
export class StorageConflictError extends Error {
  constructor(readonly reason: string) {
    super('storage conflict');
    this.name = 'StorageConflictError';
  }
}

/**
 * The storage failed while the server started (#35 architecture 3 step 7):
 * epoch, past-due timers or the restart sweep. `main` prints a Redis
 * `Startup error`, closes the storage and exits 1. Carries the original
 * error for its class and code only.
 */
export class StorageStartError extends Error {
  constructor(readonly failure: unknown) {
    super('storage start failed');
    this.name = 'StorageStartError';
  }
}

/** Reply codes that mean the Redis user may not do this (#35 AC4). */
const AUTH_CODES = new Set(['WRONGPASS', 'NOAUTH', 'NOPERM']);

/**
 * The `Startup error` text for a storage failure while starting, from the
 * error class and reply code only: never a key, value, host or user.
 */
export function storageStartMessage(err: StorageStartError): string {
  const { failure } = err;
  if (failure instanceof StorageReplyError && AUTH_CODES.has(failure.code)) {
    return 'Redis authentication failed (REDIS_URL)';
  }
  return 'Redis connection failed (REDIS_URL)';
}
