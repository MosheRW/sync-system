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
 * This instance's liveness key was gone when a commit ran (#35 security
 * C11): others may already treat it as dead, so nothing was written and
 * the instance fences itself (its sessions close with 1001).
 */
export class InstanceFencedError extends StorageUnavailableError {
  constructor() {
    super();
    this.name = 'InstanceFencedError';
  }
}

/**
 * The group's lease was lost before the commit (#35 architecture 12.4):
 * another instance took it, so this instance's view of the group may be
 * stale. Nothing was written or published; the group's local sessions
 * close with 1001.
 */
export class LeaseLostError extends StorageUnavailableError {
  constructor() {
    super();
    this.name = 'LeaseLostError';
  }
}

/**
 * Another instance held the group's lease for longer than the wait bound
 * (#35 architecture 12.4, Gate 2 Q-B4). The task never started, so nothing
 * was written; only the requester's connection closes with 1001 (security
 * C8, P2-7). Not an "unavailable" error: nothing else closes.
 */
export class StorageBusyError extends Error {
  constructor() {
    super('storage busy');
    this.name = 'StorageBusyError';
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

/**
 * The fixed `Startup error` texts of a storage failure while starting
 * (listed in docs/startup-errors.md, #36 AC40). No host, key, value or user.
 */
export const STORAGE_START_MESSAGES = {
  authentication: 'Redis authentication failed (REDIS_URL)',
  failed: 'Redis connection failed (REDIS_URL)',
} as const;

/** Reply codes that mean the Redis user may not do this (#35 AC4). */
const AUTH_CODES = new Set(['WRONGPASS', 'NOAUTH', 'NOPERM']);

/**
 * The `Startup error` text for a storage failure while starting, from the
 * error class and reply code only: never a key, value, host or user.
 */
export function storageStartMessage(err: StorageStartError): string {
  const { failure } = err;
  if (failure instanceof StorageReplyError && AUTH_CODES.has(failure.code)) {
    return STORAGE_START_MESSAGES.authentication;
  }
  return STORAGE_START_MESSAGES.failed;
}
