import type { JsonValue } from '@sync-system/protocol';
import type {
  AddParticipantResult,
  GroupRecord,
  GroupStore,
} from '../../src/groups/group-store.js';
import { InMemoryGroupStore } from '../../src/groups/in-memory-group-store.js';

/**
 * Test-only store that can be told to throw on the next call of a method,
 * to prove handler failures map to INTERNAL_ERROR without crashing (H4).
 */
export class FailingStore implements GroupStore {
  readonly inner = new InMemoryGroupStore();
  private failing = new Map<keyof GroupStore, string>();

  failNext(method: keyof GroupStore, message = 'injected store failure'): void {
    this.failing.set(method, message);
  }

  private check(method: keyof GroupStore): void {
    const message = this.failing.get(method);
    if (message !== undefined) {
      this.failing.delete(method);
      throw new Error(message);
    }
  }

  async create(group: GroupRecord): Promise<void> {
    this.check('create');
    return this.inner.create(group);
  }

  async get(namespace: string, id: string): Promise<GroupRecord | undefined> {
    this.check('get');
    return this.inner.get(namespace, id);
  }

  async addParticipant(
    namespace: string,
    id: string,
    participantId: string,
    maxSize: number,
  ): Promise<AddParticipantResult> {
    this.check('addParticipant');
    return this.inner.addParticipant(namespace, id, participantId, maxSize);
  }

  async removeParticipant(
    namespace: string,
    id: string,
    participantId: string,
  ): Promise<{ remaining: number } | undefined> {
    this.check('removeParticipant');
    return this.inner.removeParticipant(namespace, id, participantId);
  }

  async setPosition(namespace: string, id: string, payload: JsonValue): Promise<boolean> {
    this.check('setPosition');
    return this.inner.setPosition(namespace, id, payload);
  }

  async delete(namespace: string, id: string): Promise<void> {
    this.check('delete');
    return this.inner.delete(namespace, id);
  }
}
