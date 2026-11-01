import type { JsonValue } from '@sync-system/protocol';
import type { AddParticipantResult, GroupRecord, GroupStore } from './group-store.js';

function keyOf(namespace: string, id: string): string {
  // Namespaces match ^[a-z0-9][a-z0-9_-]*$, so ':' cannot be ambiguous.
  return `${namespace}:${id}`;
}

function copy(record: GroupRecord): GroupRecord {
  return { ...record, participantIds: [...record.participantIds] };
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
    if (!record) return Promise.resolve('not_found');
    if (record.participantIds.includes(participantId)) return Promise.resolve('ok');
    if (record.participantIds.length >= maxSize) return Promise.resolve('full');
    record.participantIds.push(participantId);
    return Promise.resolve('ok');
  }

  removeParticipant(
    namespace: string,
    id: string,
    participantId: string,
  ): Promise<{ remaining: number } | undefined> {
    const record = this.groups.get(keyOf(namespace, id));
    if (!record) return Promise.resolve(undefined);
    record.participantIds = record.participantIds.filter((p) => p !== participantId);
    return Promise.resolve({ remaining: record.participantIds.length });
  }

  setPosition(namespace: string, id: string, payload: JsonValue): Promise<boolean> {
    const record = this.groups.get(keyOf(namespace, id));
    if (!record) return Promise.resolve(false);
    record.position = { has: true, payload };
    return Promise.resolve(true);
  }

  delete(namespace: string, id: string): Promise<void> {
    this.groups.delete(keyOf(namespace, id));
    return Promise.resolve();
  }
}
