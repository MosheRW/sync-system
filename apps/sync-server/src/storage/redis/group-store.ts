import type { JsonValue } from '@sync-system/protocol';
import type {
  AddParticipantResult,
  GroupPatch,
  GroupRecord,
  GroupStore,
} from '../../groups/group-store.js';
import type { GroupCodes } from '../../joins/codes.js';
import { type RedisContext, type RedisWorkSource, readGroup } from './unit-of-work.js';

/**
 * GroupStore on Redis (#35 AC7, ADR 0011). Inside a locked group task every
 * call works on the task's unit of work (read once, committed once when the
 * task returns), with the same record logic as the in-memory store. A
 * read outside a task reads Redis directly; a write outside a task commits
 * at once.
 */
export class RedisGroupStore implements GroupStore {
  constructor(
    private readonly ctx: RedisContext,
    private readonly work: RedisWorkSource,
  ) {}

  create(group: GroupRecord): Promise<void> {
    return this.work.within(group.appNamespace, group.id, (work) => work.create(group, 'create'));
  }

  createIfAbsent(group: GroupRecord): Promise<'created' | 'exists'> {
    return this.work.within(group.appNamespace, group.id, async (work) => {
      const entry = await work.entry(group.appNamespace, group.id);
      if (entry.existed && !entry.deleted) return 'exists';
      await work.create(group, 'ifAbsent');
      return 'created';
    });
  }

  async get(namespace: string, id: string): Promise<GroupRecord | undefined> {
    const running = this.work.current();
    if (running === undefined) return (await readGroup(this.ctx, namespace, id))?.record;
    await running.entry(namespace, id);
    return running.cache.get(namespace, id);
  }

  addParticipant(
    namespace: string,
    id: string,
    participantId: string,
    maxSize: number,
  ): Promise<AddParticipantResult> {
    return this.work.within(namespace, id, async (work) => {
      await work.entry(namespace, id);
      return work.cache.addParticipant(namespace, id, participantId, maxSize);
    });
  }

  removeParticipant(
    namespace: string,
    id: string,
    participantId: string,
  ): Promise<{ connected: number } | undefined> {
    return this.work.within(namespace, id, async (work) => {
      await work.entry(namespace, id);
      return work.cache.removeParticipant(namespace, id, participantId);
    });
  }

  setLeaderOnline(
    namespace: string,
    id: string,
    online: boolean,
    at?: number,
  ): Promise<GroupRecord | undefined> {
    return this.work.within(namespace, id, async (work) => {
      await work.entry(namespace, id);
      return work.cache.setLeaderOnline(namespace, id, online, at);
    });
  }

  setPosition(namespace: string, id: string, payload: JsonValue, at: number): Promise<boolean> {
    return this.work.within(namespace, id, async (work) => {
      await work.entry(namespace, id);
      return work.cache.setPosition(namespace, id, payload, at);
    });
  }

  setBlockList(
    namespace: string,
    id: string,
    blockList: readonly string[],
  ): Promise<{ removed: string[] } | undefined> {
    return this.work.within(namespace, id, async (work) => {
      await work.entry(namespace, id);
      return work.cache.setBlockList(namespace, id, blockList);
    });
  }

  patch(namespace: string, id: string, patch: GroupPatch): Promise<GroupRecord | undefined> {
    return this.work.within(namespace, id, async (work) => {
      await work.entry(namespace, id);
      return work.cache.patch(namespace, id, patch);
    });
  }

  setCodes(namespace: string, id: string, codes: GroupCodes): Promise<GroupRecord | undefined> {
    return this.work.within(namespace, id, async (work) => {
      await work.entry(namespace, id);
      return work.cache.setCodes(namespace, id, codes);
    });
  }

  delete(namespace: string, id: string): Promise<void> {
    return this.work.within(namespace, id, (work) => work.remove(namespace, id));
  }
}
