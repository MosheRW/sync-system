import { z } from '../content/zod.js';

/**
 * Everything the reader keeps between page loads, per tab, in
 * `sessionStorage` (ADR 0009, #24 security R5). Every access catches
 * storage exceptions (private modes, quota, sandboxed frames) and treats a
 * failure as "nothing stored". Values are versioned JSON, validated with
 * strict codecs on read; an invalid value is deleted. Never stored here:
 * codes, door codes, QR tickets, other people's names, leader metadata.
 */

/** The Web Storage surface used (`sessionStorage` fits; tests pass a fake). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function browserSessionStorage(): StorageLike | null {
  return typeof sessionStorage === 'undefined' ? null : sessionStorage;
}

/**
 * A guarded `sessionStorage` (same shape as the sync client's
 * `TokenStorage`), or `null` when it is missing or throws on access. For the
 * client's `storage` option: `safeSessionStorage() ?? 'memory'` (ADR 0009).
 */
export function safeSessionStorage(
  lookup: () => StorageLike | null = browserSessionStorage,
): StorageLike | null {
  let storage: StorageLike | null;
  try {
    storage = lookup();
    // Some private modes expose the object but throw on use.
    storage?.getItem('reader:v1:probe');
  } catch {
    return null;
  }
  if (storage === null) return null;
  const target = storage;
  return {
    getItem: (key) => {
      try {
        return target.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        target.setItem(key, value);
      } catch {
        // Quota or a revoked storage: treated as not stored.
      }
    },
    removeItem: (key) => {
      try {
        target.removeItem(key);
      } catch {
        // Nothing more to do.
      }
    },
  };
}

/** A real group ID: 32 random bytes in base64url (the protocol's GROUP_ID_PATTERN, #1 L3). */
export const GROUP_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

export type FollowMode = 'following' | 'browsing';

/** The group this tab is in, so a reload resumes it (AC34). */
export interface GroupPointer {
  groupId: string;
  /** The member's follow mode at the last change (Decision Q3). */
  mode: FollowMode;
  /** The leader fingerprint whose version warning was acknowledged (design F6), or null. */
  ack: string | null;
  /** The leader showed the QR code (design 4.3). */
  qrShown: boolean;
}

const pointerSchema = z.strictObject({
  v: z.literal(1),
  groupId: z.string().regex(GROUP_ID_PATTERN),
  mode: z.enum(['following', 'browsing']),
  ack: z.string().regex(FINGERPRINT).nullable(),
  qrShown: z.boolean(),
});

const pageSchema = z.strictObject({
  v: z.literal(1),
  pageIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export function groupPointerKey(syncHost: string): string {
  return `reader:v1:group@${syncHost}`;
}

export function pageKey(contentId: string, fingerprint: string): string {
  return `reader:v1:page:${contentId}:${fingerprint}`;
}

function readJson<T>(storage: StorageLike, key: string, schema: z.ZodType<T>): T | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    storage.removeItem(key);
    return null;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    storage.removeItem(key);
    return null;
  }
  return parsed.data;
}

const NO_STORAGE: StorageLike = {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
};

/** The group pointer, for one sync server (its `host`, so another server never resumes). */
export interface PointerStore {
  read(): GroupPointer | null;
  write(pointer: GroupPointer): void;
  /** Changes some fields of the stored pointer, if there is one. */
  update(change: Partial<Omit<GroupPointer, 'groupId'>>): void;
  forget(): void;
}

/** `storage` must already be guarded (`safeSessionStorage()`); `null` stores nothing. */
export function createPointerStore(storage: StorageLike | null, syncHost: string): PointerStore {
  const store = storage ?? NO_STORAGE;
  const key = groupPointerKey(syncHost);

  const read = (): GroupPointer | null => {
    const value = readJson(store, key, pointerSchema);
    if (value === null) return null;
    return { groupId: value.groupId, mode: value.mode, ack: value.ack, qrShown: value.qrShown };
  };

  const write = (pointer: GroupPointer): void => {
    const value = pointerSchema.safeParse({
      v: 1,
      groupId: pointer.groupId,
      mode: pointer.mode,
      ack: pointer.ack,
      qrShown: pointer.qrShown,
    });
    if (value.success) store.setItem(key, JSON.stringify(value.data));
  };

  return {
    read,
    write,
    update: (change) => {
      const current = read();
      if (current !== null) write({ ...current, ...change });
    },
    forget: () => store.removeItem(key),
  };
}

/** The reading position per book (content ID plus fingerprint, Decision Q3, AC36). */
export interface PageStore {
  /** The stored page, when valid for the book's page count. */
  read(contentId: string, fingerprint: string, pageCount: number): number | null;
  write(contentId: string, fingerprint: string, pageIndex: number): void;
}

export function createPageStore(storage: StorageLike | null): PageStore {
  const store = storage ?? NO_STORAGE;
  return {
    read: (contentId, fingerprint, pageCount) => {
      const key = pageKey(contentId, fingerprint);
      const value = readJson(store, key, pageSchema);
      if (value === null) return null;
      if (value.pageIndex >= pageCount) {
        store.removeItem(key);
        return null;
      }
      return value.pageIndex;
    },
    write: (contentId, fingerprint, pageIndex) => {
      if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) return;
      store.setItem(pageKey(contentId, fingerprint), JSON.stringify({ v: 1, pageIndex }));
    },
  };
}
