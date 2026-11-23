import { EndedGroups, type EndedGroupsStore } from '../groups/ended-groups.js';
import { IMMEDIATE_WORK, type LeaseSource, type UnitOfWorkSource } from '../groups/group-lock.js';
import type { GroupStore } from '../groups/group-store.js';
import { MemoryTimerBackend, type TimerBackend } from '../groups/group-timers.js';
import { InMemoryGroupStore } from '../groups/in-memory-group-store.js';
import { CodeIndex, type CodeIndexStore } from '../joins/code-index.js';
import type { DoorStateStore } from '../joins/door-guard.js';
import type { EvictionLogger } from '../groups/ended-groups.js';
import type { Scheduler } from '../time/scheduler.js';
import { MemoryDoorStates, MemoryEndedGroups } from './memory/memory-state.js';
import type { EpochSource } from './redis/epoch.js';
import type { ClusterHost } from '../groups/cluster-notifier.js';
import type { RemoteReceiver } from './redis/pubsub.js';
import type { ApprovalStore } from '../joins/approval-store.js';
import type { ParkingRegistry } from './redis/parking.js';
import { type LiveGroupsStore, MemoryLiveGroups } from '../groups/live-groups.js';

/** What `SyncServer.storage()` reports (#35 AC27). */
export type StorageStatus =
  { kind: 'memory' } | { kind: 'redis'; state: 'connected' | 'unreachable' };

/** Several instances on one Redis (#35 architecture 12). */
export interface StorageCluster {
  /** Registry resolution and remote effects for the group layer (12.6, 12.7). */
  readonly host: ClusterHost;
  /** This instance must not act now (security C11: the synchronous guard). */
  fenced(): boolean;
  /**
   * Called when this instance fences itself (#35 architecture 12.5): every
   * session in a group, parked or pending is closed with 1001, without the
   * disconnect rules (security C13).
   */
  onFence(listener: () => void): void;
  /**
   * Called when effects from other instances may have been lost (the
   * subscriber link dropped, stalled or lagged; #35 architecture 12.7):
   * every session in a group, parked or pending is closed with 1001.
   */
  onResync(listener: () => void): void;
  /** Where effects received from other instances go. */
  setReceiver(receiver: RemoteReceiver): void;
}

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
  /** Live groups per app and the app's create budget (#12). */
  readonly liveGroups: LiveGroupsStore;
  readonly work: UnitOfWorkSource;
  status(): StorageStatus;
  /** The store's epoch (Redis); the in-memory store uses the process start. */
  readonly epoch?: EpochSource;
  /** Keep stored attachments on a clean stop (Redis, #35 AC11). */
  readonly keepAttachmentsOnClose: boolean;
  /** Set with Redis: this process is one of several instances (#35 architecture 12). */
  readonly cluster?: StorageCluster;
  /** The group leases across instances (#35 architecture 12.4); memory has none. */
  readonly leases?: LeaseSource;
  /** Pending method B requests in Redis (#35 architecture 12.9); memory: the service's own. */
  readonly approvals?: ApprovalStore;
  /** Which instances hold parked members of a missing group (Redis, 12.10). */
  readonly parked?: ParkingRegistry;
  /**
   * Runs before the server listens (Redis, #35 architecture 7, 12.8): the
   * epoch, this instance's registration and channel, the timers that came
   * due while the server was down (AC12), `sweep` (with `restart`) for the
   * groups of stopped instances and of PR 1 (the restart grace, AC11), then
   * the timer poll and, from then on, the periodic orphan sweep.
   */
  start(
    sweep: (namespace: string, groupId: string, restart: boolean) => Promise<number>,
  ): Promise<void>;
  /** Calls `listener` each time Redis is reachable again (#35 architecture 8). */
  onRecovered(listener: () => Promise<void>): void;
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
    liveGroups: new MemoryLiveGroups(() => scheduler.now()),
    work: IMMEDIATE_WORK,
    status: () => ({ kind: 'memory' }),
    keepAttachmentsOnClose: false,
    onRecovered: () => undefined,
    start: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}
