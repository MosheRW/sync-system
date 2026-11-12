import { EndedGroups, type EndedGroupsStore } from '../groups/ended-groups.js';
import { IMMEDIATE_WORK, type UnitOfWorkSource } from '../groups/group-lock.js';
import type { GroupStore } from '../groups/group-store.js';
import { MemoryTimerBackend, type TimerBackend } from '../groups/group-timers.js';
import { InMemoryGroupStore } from '../groups/in-memory-group-store.js';
import { CodeIndex, type CodeIndexStore } from '../joins/code-index.js';
import type { DoorStateStore } from '../joins/door-guard.js';
import type { EvictionLogger } from '../groups/ended-groups.js';
import type { Scheduler } from '../time/scheduler.js';
import { MemoryDoorStates, MemoryEndedGroups } from './memory/memory-state.js';

/** What `SyncServer.storage()` reports (#35 AC27). */
export type StorageStatus =
  { kind: 'memory' } | { kind: 'redis'; state: 'connected' | 'unreachable' };

/**
 * Everything the group layer keeps (#35 architecture 5): groups, the code
 * index, ended groups, door state and timers, plus the unit of work that
 * makes one locked task one atomic step. Memory by default; Redis when
 * `REDIS_URL` is set.
 */
export interface Storage {
  readonly kind: 'memory' | 'redis';
  readonly groups: GroupStore;
  readonly codes: CodeIndexStore;
  readonly ended: EndedGroupsStore;
  readonly doors: DoorStateStore;
  readonly timers: TimerBackend;
  readonly work: UnitOfWorkSource;
  status(): StorageStatus;
  /**
   * Runs before the server listens (Redis: past-due timers, then the timer
   * poll, #35 AC12). The group service exists by then.
   */
  start(): Promise<void>;
  /** Releases connections (Redis). Stored data stays. */
  close(): Promise<void>;
}

export interface MemoryStorageOptions {
  scheduler: Scheduler;
  logger: EvictionLogger;
  /** Defaults to a new InMemoryGroupStore (tests inject failing stores). */
  groups?: GroupStore;
  /** Cap of the ended-groups memory; defaults to MAX_ENDED_GROUPS. */
  endedGroupsCap?: number;
}

/** The in-memory storage: a restart forgets everything (#5 AC16). */
export function memoryStorage(options: MemoryStorageOptions): Storage {
  const { scheduler } = options;
  return {
    kind: 'memory',
    groups: options.groups ?? new InMemoryGroupStore(),
    codes: new CodeIndex(),
    ended: new MemoryEndedGroups(
      new EndedGroups(() => scheduler.now(), options.logger, options.endedGroupsCap),
    ),
    doors: new MemoryDoorStates(),
    timers: new MemoryTimerBackend(scheduler),
    work: IMMEDIATE_WORK,
    status: () => ({ kind: 'memory' }),
    start: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}
