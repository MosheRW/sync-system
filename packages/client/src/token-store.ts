import {
  type JsonObject,
  type JsonValue,
  MAX_BLOCK_LIST_SIZE,
  MAX_JSON_DEPTH,
  MAX_TOKEN_LENGTH,
  PARTICIPANT_ID_PATTERN,
  type TokenClaims,
  checkJson,
  decodeTokenClaims,
} from '@sync-system/protocol';
import { type TimerHandle, clearTimer, now, setClampedTimeout } from './host.js';
import { type StorageLog, type TokenStorage, storageErrorName } from './storage.js';

/** Version of the stored document. */
export const STORAGE_DOC_VERSION = 1;

/** Most tokens kept per server and app (#5 AC33). */
export const MAX_STORED_TOKENS = 20;

/** Stored text above this is ignored as corrupt (L8). */
export const MAX_STORED_DOCUMENT_CHARS = 262_144;

/** Max session time assumed before the server said otherwise: the server ceiling (M6). */
export const DEFAULT_MAX_SESSION_MINUTES = 480;

/** Position saves are written at most this often (architecture 7.2). */
export const POSITION_SAVE_INTERVAL_MS = 1_000;

/** The single storage key per server and app (#5 AC33, Q12). */
export function storageKey(namespace: string, host: string): string {
  return `sync-system:v1:${namespace}@${host}`;
}

/** What a leader's client keeps to recreate its group (#5 AC34). */
export interface Recovery {
  readonly metadata: JsonObject;
  readonly hasPosition: boolean;
  readonly position?: JsonValue;
  readonly blockList: readonly string[];
}

/** One stored token. `claims` are decoded from the token on load, never stored. */
export interface StoredEntry {
  readonly token: string;
  readonly claims: TokenClaims;
  /** Leader tokens only. */
  readonly recovery?: Recovery;
}

type Change = (entries: readonly StoredEntry[]) => readonly StoredEntry[];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlockList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_BLOCK_LIST_SIZE &&
    value.every((id) => typeof id === 'string' && PARTICIPANT_ID_PATTERN.test(id))
  );
}

/** A stored recovery object, or undefined if it is not well formed. */
function readRecovery(value: unknown): Recovery | undefined {
  if (!isObject(value)) return undefined;
  if (checkJson(value, { maxDepth: MAX_JSON_DEPTH }) !== 'ok') return undefined;
  const { metadata, hasPosition, position, blockList } = value;
  if (!isObject(metadata) || typeof hasPosition !== 'boolean' || !isBlockList(blockList)) {
    return undefined;
  }
  if (hasPosition && !Object.hasOwn(value, 'position')) return undefined;
  return hasPosition
    ? { metadata: metadata as JsonObject, hasPosition, position: position as JsonValue, blockList }
    : { metadata: metadata as JsonObject, hasPosition, blockList };
}

function serialize(entries: readonly StoredEntry[]): string {
  return JSON.stringify({
    v: STORAGE_DOC_VERSION,
    entries: entries.map((entry) =>
      entry.recovery === undefined
        ? { token: entry.token }
        : {
            token: entry.token,
            recovery: {
              metadata: entry.recovery.metadata,
              hasPosition: entry.recovery.hasPosition,
              ...(entry.recovery.hasPosition ? { position: entry.recovery.position } : {}),
              blockList: entry.recovery.blockList,
            },
          },
    ),
  });
}

/**
 * The client's tokens for one server and app, kept as one versioned JSON
 * document under one key (#5 AC31, AC33, AC34).
 *
 * - Every operation runs through one promise chain, and every write is
 *   read-merge-write (the document is read again, the change applied,
 *   pruned, then written), so two tabs sharing `localStorage` overwrite each
 *   other less often.
 * - Stored data is untrusted: anything unparsable or wrongly shaped is
 *   discarded without throwing; group, role and times come from each token's
 *   claims, decoded on every load.
 * - Pruned on load and on write: expired tokens (`exp`), tokens past their
 *   group's max session time (M6), then the oldest by last activity until at
 *   most 20 remain.
 * - Storage failures never reject: they are logged by error name and the
 *   in-memory copy is kept. Nothing here throws.
 * - Groups whose last write failed are dirty: until a write succeeds, their
 *   in-memory entry (or its absence) wins over what storage returns, so a
 *   readable store whose writes fail (quota full) never brings back a stale
 *   token. Other groups still merge in from storage.
 */
export class TokenStore {
  readonly #storage: TokenStorage;
  readonly #key: string;
  readonly #namespace: string;
  readonly #log: StorageLog;
  #maxSessionMs: number;
  #entries: readonly StoredEntry[] = [];
  #chain: Promise<void> = Promise.resolve();
  #pendingPositions = new Map<string, { hasPosition: boolean; position?: JsonValue }>();
  /** Groups whose latest change is only in memory because a write failed. */
  readonly #dirty = new Set<string>();
  #positionTimer: TimerHandle | undefined;

  constructor(
    storage: TokenStorage,
    namespace: string,
    host: string,
    log: StorageLog,
    maxSessionMinutes = DEFAULT_MAX_SESSION_MINUTES,
  ) {
    this.#storage = storage;
    this.#namespace = namespace;
    this.#key = storageKey(namespace, host);
    this.#log = log;
    this.#maxSessionMs = maxSessionMinutes * 60_000;
  }

  get key(): string {
    return this.#key;
  }

  setMaxSessionMinutes(minutes: number): void {
    this.#maxSessionMs = minutes * 60_000;
  }

  /** The in-memory copy (current after the last completed operation). */
  entries(): readonly StoredEntry[] {
    return this.#entries;
  }

  /** The in-memory entry for `groupId`, if any. */
  find(groupId: string): StoredEntry | undefined {
    return this.#entries.find((entry) => entry.claims.gid === groupId);
  }

  /** Reads the document again (another tab may have written) and returns the entries. */
  load(): Promise<readonly StoredEntry[]> {
    return this.#run(async () => {
      this.#entries = this.#prune(this.#applyPending(await this.#read()));
      return this.#entries;
    });
  }

  /** The entry for `groupId` as stored now (read from storage first, L5). */
  async findFresh(groupId: string): Promise<StoredEntry | undefined> {
    await this.load();
    return this.find(groupId);
  }

  /**
   * Stores `token`, replacing the previous token for its group (#5 AC31).
   * Leader recovery data is kept unless `recovery` replaces it; member tokens
   * carry none. An undecodable token is not stored.
   */
  saveToken(token: string, recovery?: Recovery): Promise<void> {
    const claims = decodeTokenClaims(token);
    if (claims === undefined || claims.aud !== this.#namespace) return Promise.resolve();
    return this.#mutate((entries) => {
      const previous = entries.find((entry) => entry.claims.gid === claims.gid);
      const kept = recovery ?? (previous?.claims.role === 'leader' ? previous.recovery : undefined);
      const entry: StoredEntry =
        claims.role === 'leader' && kept !== undefined
          ? { token, claims, recovery: kept }
          : { token, claims };
      return [...entries.filter((e) => e.claims.gid !== claims.gid), entry];
    }, 'token_stored');
  }

  /** Changes a leader's stored recovery data (metadata, position, block list). */
  updateRecovery(groupId: string, patch: Partial<Recovery>): Promise<void> {
    if ('hasPosition' in patch) this.#pendingPositions.delete(groupId);
    return this.#mutate((entries) =>
      entries.map((entry) => {
        if (entry.claims.gid !== groupId || entry.recovery === undefined) return entry;
        return { ...entry, recovery: { ...entry.recovery, ...patch } };
      }),
    );
  }

  /**
   * Changes a leader's stored block list in one read-merge-write step (#5
   * AC34). `not_found` without a stored leader token for the group; `full`
   * (nothing written) if the result would hold more than 256 IDs.
   */
  editBlockList(
    groupId: string,
    change: (current: readonly string[]) => readonly string[],
  ): Promise<
    { ok: true; blockList: readonly string[] } | { ok: false; reason: 'not_found' | 'full' }
  > {
    return this.#run(async () => {
      const base = await this.#read();
      const current = this.#prune(this.#applyPending(base));
      const entry = current.find((e) => e.claims.gid === groupId);
      if (entry?.claims.role !== 'leader' || entry.recovery === undefined) {
        this.#entries = current;
        return { ok: false, reason: 'not_found' } as const;
      }
      const blockList = [...new Set(change(entry.recovery.blockList))];
      if (blockList.length > MAX_BLOCK_LIST_SIZE) {
        this.#entries = current;
        return { ok: false, reason: 'full' } as const;
      }
      const next = current.map((e) =>
        e === entry ? { ...entry, recovery: { ...entry.recovery!, blockList } } : e,
      );
      this.#pendingPositions.clear();
      this.#entries = next;
      await this.#write(base, next);
      return { ok: true, blockList } as const;
    });
  }

  /**
   * Records the leader's latest position. The in-memory copy changes at
   * once; storage is written at most once per second.
   */
  savePosition(groupId: string, position: JsonValue): void {
    this.#pendingPositions.set(groupId, { hasPosition: true, position });
    this.#entries = this.#applyPending(this.#entries);
    if (this.#positionTimer !== undefined) return;
    this.#positionTimer = setClampedTimeout(() => {
      this.#positionTimer = undefined;
      void this.flush();
    }, POSITION_SAVE_INTERVAL_MS);
  }

  /** Writes a pending position now (on drop and close). */
  flush(): Promise<void> {
    clearTimer(this.#positionTimer);
    this.#positionTimer = undefined;
    if (this.#pendingPositions.size === 0) return this.#chain;
    return this.#mutate((entries) => entries);
  }

  /** Deletes the tokens and recovery data of `groupIds` (#5 AC31). */
  remove(groupIds: readonly string[]): Promise<void> {
    for (const id of groupIds) this.#pendingPositions.delete(id);
    const doomed = new Set(groupIds);
    return this.#mutate(
      (entries) => entries.filter((entry) => !doomed.has(entry.claims.gid)),
      'token_deleted',
      groupIds.length,
    );
  }

  /** Deletes every token for this server and app, and the key itself (M6). */
  removeAll(): Promise<void> {
    this.#pendingPositions.clear();
    clearTimer(this.#positionTimer);
    this.#positionTimer = undefined;
    return this.#run(async () => {
      const previous = this.#entries;
      const count = previous.length;
      this.#entries = [];
      try {
        await this.#storage.removeItem(this.#key);
        this.#dirty.clear();
      } catch (error) {
        this.#log('warn', 'storage_error', { op: 'remove', name: storageErrorName(error) });
        for (const entry of previous) this.#dirty.add(entry.claims.gid);
      }
      this.#log('debug', 'token_deleted', { count });
    });
  }

  /** Waits for every queued operation. */
  idle(): Promise<void> {
    return this.#chain;
  }

  #run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(task);
    // The chain only ever resolves, so one failure never blocks the next.
    this.#chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #mutate(change: Change, event?: string, count?: number): Promise<void> {
    return this.#run(async () => {
      // Pending positions go on top: they are newer than anything stored.
      const base = await this.#read();
      const next = this.#prune(this.#applyPending(change(base)));
      this.#pendingPositions.clear();
      this.#entries = next;
      await this.#write(base, next);
      if (event !== undefined) {
        this.#log('debug', event, count === undefined ? undefined : { count });
      }
    }).catch(() => undefined);
  }

  /**
   * Writes `next`, which was derived from `base`. On success nothing is dirty
   * any more (the document holds every in-memory change). On failure, every
   * group whose entry differs between `base` and `next` becomes dirty.
   */
  async #write(base: readonly StoredEntry[], next: readonly StoredEntry[]): Promise<void> {
    try {
      await this.#storage.setItem(this.#key, serialize(next));
      this.#dirty.clear();
    } catch (error) {
      this.#log('warn', 'storage_error', { op: 'set', name: storageErrorName(error) });
      const before = new Map(base.map((entry) => [entry.claims.gid, entry]));
      const after = new Map(next.map((entry) => [entry.claims.gid, entry]));
      for (const gid of new Set([...before.keys(), ...after.keys()])) {
        if (before.get(gid) !== after.get(gid)) this.#dirty.add(gid);
      }
    }
  }

  /** Pending positions applied onto `entries`. */
  #applyPending(entries: readonly StoredEntry[]): readonly StoredEntry[] {
    if (this.#pendingPositions.size === 0) return entries;
    const result = entries.map((entry) => {
      const pending = this.#pendingPositions.get(entry.claims.gid);
      if (pending === undefined || entry.recovery === undefined) return entry;
      return { ...entry, recovery: { ...entry.recovery, ...pending } };
    });
    return result;
  }

  /** The stored entries, with dirty groups taken from memory instead. */
  async #read(): Promise<readonly StoredEntry[]> {
    const stored = await this.#readStored();
    if (this.#dirty.size === 0) return stored;
    return [
      ...stored.filter((entry) => !this.#dirty.has(entry.claims.gid)),
      ...this.#entries.filter((entry) => this.#dirty.has(entry.claims.gid)),
    ];
  }

  /** Reads and validates the stored document. On a read failure, the in-memory copy. */
  async #readStored(): Promise<readonly StoredEntry[]> {
    let text: unknown;
    try {
      text = await this.#storage.getItem(this.#key);
    } catch (error) {
      this.#log('warn', 'storage_error', { op: 'get', name: storageErrorName(error) });
      return this.#entries;
    }
    if (typeof text !== 'string' || text.length > MAX_STORED_DOCUMENT_CHARS) return [];
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      return [];
    }
    if (checkJson(document, { maxDepth: MAX_JSON_DEPTH }) !== 'ok') return [];
    if (!isObject(document) || document.v !== STORAGE_DOC_VERSION) return [];
    if (!Array.isArray(document.entries)) return [];
    const byGroup = new Map<string, StoredEntry>();
    for (const raw of (document.entries as unknown[]).slice(0, MAX_STORED_TOKENS)) {
      const entry = this.#readEntry(raw);
      if (entry === undefined) continue;
      const existing = byGroup.get(entry.claims.gid);
      // Duplicate group: the newest token wins.
      if (existing === undefined || entry.claims.iat > existing.claims.iat) {
        byGroup.set(entry.claims.gid, entry);
      }
    }
    return [...byGroup.values()];
  }

  #readEntry(raw: unknown): StoredEntry | undefined {
    if (!isObject(raw)) return undefined;
    const { token } = raw;
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return undefined;
    const claims = decodeTokenClaims(token);
    if (claims === undefined || claims.aud !== this.#namespace) return undefined;
    if (claims.role !== 'leader' || raw.recovery === undefined) return { token, claims };
    const recovery = readRecovery(raw.recovery);
    return recovery === undefined ? undefined : { token, claims, recovery };
  }

  /** Expired first (by `exp` and by max session), then the oldest by last activity. */
  #prune(entries: readonly StoredEntry[]): readonly StoredEntry[] {
    const time = now();
    const alive = entries.filter(
      (entry) => entry.claims.exp * 1000 > time && entry.claims.gct + this.#maxSessionMs > time,
    );
    if (alive.length <= MAX_STORED_TOKENS) return alive;
    const keep = new Set(
      [...alive].sort((a, b) => b.claims.lat - a.claims.lat).slice(0, MAX_STORED_TOKENS),
    );
    return alive.filter((entry) => keep.has(entry));
  }
}
