import type { JsonValue } from '@mosherw/sync-system-protocol';
import type { GroupCodes } from '../joins/codes.js';
import {
  type AddParticipantResult,
  type GroupPatch,
  type GroupRecord,
  type GroupStore,
  connectedCount,
} from './group-store.js';

function keyOf(namespace: string, id: string): string {
  // Namespaces match ^[a-z0-9][a-z0-9_-]*$, so ':' cannot be ambiguous.
  return `${namespace}:${id}`;
}

function copy(record: GroupRecord): GroupRecord {
  return {
    ...record,
    participantIds: [...record.participantIds],
    blockList: [...record.blockList],
    joinMethods: [...record.joinMethods],
    codes: { ...record.codes },
    // Entries are never mutated in place, so a copy of the array is enough.
    roster: [...record.roster],
  };
}

/**
 * Map-based GroupStore. Each method body runs synchronously, so every
 * operation is atomic. A restart means a new, empty store (AC16).
 */
export class InMemoryGroupStore implements GroupStore {
  private readonly groups = new Map<string, GroupRecord>();

  /** Number of stored groups. For tests and diagnostics only. */
  get size(): number {
    return this.groups.size;
  }

  create(group: GroupRecord): Promise<void> {
    this.groups.set(keyOf(group.appNamespace, group.id), copy(group));
    return Promise.resolve();
  }

  createIfAbsent(group: GroupRecord): Promise<'created' | 'exists'> {
    const key = keyOf(group.appNamespace, group.id);
    if (this.groups.has(key)) return Promise.resolve('exists');
    this.groups.set(key, copy(group));
    return Promise.resolve('created');
  }

  get(namespace: string, id: string): Promise<GroupRecord | undefined> {
    const record = this.groups.get(keyOf(namespace, id));
    return Promise.resolve(record ? copy(record) : undefined);
  }

  addParticipant(
    namespace: string,
    id: string,
    participantId: string,
    maxSize: number,
  ): Promise<AddParticipantResult> {
    const record = this.groups.get(keyOf(namespace, id));
    if (!record) return Promise.resolve({ status: 'not_found' });
    if (record.blockList.includes(participantId)) return Promise.resolve({ status: 'blocked' });
    if (!record.participantIds.includes(participantId)) {
      if (record.participantIds.length >= maxSize) return Promise.resolve({ status: 'full' });
      record.participantIds.push(participantId);
    }
    return Promise.resolve({ status: 'ok', group: copy(record) });
  }

  removeParticipant(
    namespace: string,
    id: string,
    participantId: string,
  ): Promise<{ connected: number } | undefined> {
    const record = this.groups.get(keyOf(namespace, id));
    if (!record) return Promise.resolve(undefined);
    // The leader's slot is reserved while it is offline (architecture 3).
    if (participantId !== record.leaderId) {
      record.participantIds = record.participantIds.filter((p) => p !== participantId);
    }
    return Promise.resolve({ connected: connectedCount(record) });
  }

  setLeaderOnline(
    namespace: string,
    id: string,
    online: boolean,
    at?: number,
  ): Promise<GroupRecord | undefined> {
    const record = this.groups.get(keyOf(namespace, id));
    if (!record) return Promise.resolve(undefined);
    record.leaderOnline = online;
    if (online && at !== undefined) record.lastActivityAt = at;
    return Promise.resolve(copy(record));
  }

  setPosition(namespace: string, id: string, payload: JsonValue, at: number): Promise<boolean> {
    const record = this.groups.get(keyOf(namespace, id));
    if (!record) return Promise.resolve(false);
    record.position = { has: true, payload };
    record.lastActivityAt = at;
    return Promise.resolve(true);
  }

  setBlockList(
    namespace: string,
    id: string,
    blockList: readonly string[],
  ): Promise<{ removed: string[] } | undefined> {
    const record = this.groups.get(keyOf(namespace, id));
    if (!record) return Promise.resolve(undefined);
    record.blockList = [...blockList];
    const blocked = new Set(blockList);
    const removed = record.participantIds.filter((p) => p !== record.leaderId && blocked.has(p));
    record.participantIds = record.participantIds.filter((p) => !removed.includes(p));
    return Promise.resolve({ removed });
  }

  patch(namespace: string, id: string, patch: GroupPatch): Promise<GroupRecord | undefined> {
    const record = this.groups.get(keyOf(namespace, id));
    if (!record) return Promise.resolve(undefined);
    // `copy` of the patch, so the caller keeps no reference into the store.
    Object.assign(record, copy({ ...record, ...patch }));
    return Promise.resolve(copy(record));
  }

  setCodes(namespace: string, id: string, codes: GroupCodes): Promise<GroupRecord | undefined> {
    const record = this.groups.get(keyOf(namespace, id));
    if (!record) return Promise.resolve(undefined);
    record.codes = { ...codes };
    return Promise.resolve(copy(record));
  }

  delete(namespace: string, id: string): Promise<void> {
    this.groups.delete(keyOf(namespace, id));
    return Promise.resolve();
  }
}
