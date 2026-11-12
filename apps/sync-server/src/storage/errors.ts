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
