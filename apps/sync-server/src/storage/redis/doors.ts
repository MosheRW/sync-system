import { DoorGuard, type DoorStateStore, type RotationResult } from '../../joins/door-guard.js';
import type { RedisUnitOfWork, RedisWorkSource } from './unit-of-work.js';

const KEY = 'group';

/**
 * Door-code state in the group document (#10 AC29, #35 AC7): the same rules
 * as `DoorGuard`, applied to the state the task's unit of work read with
 * the group, and stored in the same commit.
 */
export class RedisDoorStates implements DoorStateStore {
  constructor(private readonly work: RedisWorkSource) {}

  private async apply<T>(
    namespace: string,
    groupId: string,
    step: (guard: DoorGuard) => T,
  ): Promise<T> {
    return this.work.within(namespace, groupId, async (work: RedisUnitOfWork) => {
      const entry = await work.entry(namespace, groupId);
      const guard = new DoorGuard();
      guard.importState(KEY, entry.door);
      const result = step(guard);
      entry.door = guard.exportState(KEY);
      return result;
    });
  }

  recordFailure(namespace: string, groupId: string): Promise<'counted' | 'rotate'> {
    return this.apply(namespace, groupId, (guard) => guard.recordFailure(KEY));
  }

  recordRotation(namespace: string, groupId: string, now: number): Promise<RotationResult> {
    return this.apply(namespace, groupId, (guard) => guard.recordRotation(KEY, now));
  }

  pausedFor(namespace: string, groupId: string, now: number): Promise<number> {
    return this.apply(namespace, groupId, (guard) => guard.pausedFor(KEY, now));
  }

  endPause(namespace: string, groupId: string, now: number): Promise<boolean> {
    return this.apply(namespace, groupId, (guard) => guard.endPause(KEY, now));
  }

  reset(namespace: string, groupId: string, now: number): Promise<boolean> {
    return this.apply(namespace, groupId, (guard) => guard.reset(KEY, now));
  }

  clear(namespace: string, groupId: string): Promise<void> {
    return this.apply(namespace, groupId, (guard) => guard.clear(KEY));
  }

  /** Nothing local: the state lives with the group. */
  clearAll(): void {
    return undefined;
  }
}
