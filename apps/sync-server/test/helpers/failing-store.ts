import type { JsonValue } from '@sync-system/protocol';
import type { GroupCodes } from '../../src/joins/codes.js';
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

  async setCodes(
    namespace: string,
    id: string,
    codes: GroupCodes,
  ): Promise<GroupRecord | undefined> {
    this.check('setCodes');
    return this.inner.setCodes(namespace, id, codes);
  }

  async create(group: GroupRecord): Promise<void> {
    this.check('create');
    return this.inner.create(group);
  }

  async createIfAbsent(group: GroupRecord): Promise<'created' | 'exists'> {
    this.check('createIfAbsent');
    return this.inner.createIfAbsent(group);
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
  ): Promise<{ connected: number } | undefined> {
    this.check('removeParticipant');
    return this.inner.removeParticipant(namespace, id, participantId);
  }

  async setLeaderOnline(
    namespace: string,
    id: string,
    online: boolean,
    at?: number,
  ): Promise<GroupRecord | undefined> {
    this.check('setLeaderOnline');
    return this.inner.setLeaderOnline(namespace, id, online, at);
  }

  async setPosition(
    namespace: string,
    id: string,
    payload: JsonValue,
    at: number,
  ): Promise<boolean> {
    this.check('setPosition');
    return this.inner.setPosition(namespace, id, payload, at);
  }

  async setBlockList(
    namespace: string,
    id: string,
    blockList: readonly string[],
  ): Promise<{ removed: string[] } | undefined> {
    this.check('setBlockList');
    return this.inner.setBlockList(namespace, id, blockList);
  }

  async delete(namespace: string, id: string): Promise<void> {
    this.check('delete');
    return this.inner.delete(namespace, id);
  }
}
