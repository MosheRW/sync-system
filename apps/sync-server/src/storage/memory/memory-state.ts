import type { EndedGroups, EndedGroupsStore } from '../../groups/ended-groups.js';
import { DoorGuard, type DoorStateStore, type RotationResult } from '../../joins/door-guard.js';

function keyOf(namespace: string, groupId: string): string {
  return `${namespace}:${groupId}`;
}

/** `DoorGuard` behind the async door-state interface (#35). */
export class MemoryDoorStates implements DoorStateStore {
  readonly guard = new DoorGuard();

  recordFailure(namespace: string, groupId: string): Promise<'counted' | 'rotate'> {
    return Promise.resolve(this.guard.recordFailure(keyOf(namespace, groupId)));
  }

  recordRotation(namespace: string, groupId: string, now: number): Promise<RotationResult> {
    return Promise.resolve(this.guard.recordRotation(keyOf(namespace, groupId), now));
  }

  pausedFor(namespace: string, groupId: string, now: number): Promise<number> {
    return Promise.resolve(this.guard.pausedFor(keyOf(namespace, groupId), now));
  }

  endPause(namespace: string, groupId: string, now: number): Promise<boolean> {
    return Promise.resolve(this.guard.endPause(keyOf(namespace, groupId), now));
  }

  reset(namespace: string, groupId: string, now: number): Promise<boolean> {
    return Promise.resolve(this.guard.reset(keyOf(namespace, groupId), now));
  }

  clear(namespace: string, groupId: string): Promise<void> {
    this.guard.clear(keyOf(namespace, groupId));
    return Promise.resolve();
  }

  clearAll(): void {
    this.guard.clearAll();
  }
}

/** `EndedGroups` behind the async ended-groups interface (#35). */
export class MemoryEndedGroups implements EndedGroupsStore {
  constructor(readonly groups: EndedGroups) {}

  remember(
    namespace: string,
    groupId: string,
    deadline: number,
    guardUntil?: number,
  ): Promise<void> {
    this.groups.remember(namespace, groupId, deadline, guardUntil);
    return Promise.resolve();
  }

  has(namespace: string, groupId: string): Promise<boolean> {
    return Promise.resolve(this.groups.has(namespace, groupId));
  }

  isRecoveryClosed(namespace: string): Promise<boolean> {
    return Promise.resolve(this.groups.isRecoveryClosed(namespace));
  }

  sweep(): void {
    this.groups.sweep();
  }
}
