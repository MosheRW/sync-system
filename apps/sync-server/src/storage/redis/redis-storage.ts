import type { AppConfig } from '../../apps/app-registry.js';
import { END_TTL_SLACK_MS, ORPHAN_SWEEP_MS, TIMER_LEASE_MS } from '../../limits/constants.js';
import { type Logger, safeErr } from '../../logging/logger.js';
import type { Scheduler } from '../../time/scheduler.js';
import { type Storage, memoryStorage } from '../storage.js';
import type { RedisLink } from './connect.js';
import { RedisCodeIndex } from './codes.js';
import { RedisDoorStates } from './doors.js';
import { RedisEndedGroups } from './ended.js';
import { RedisGroupStore } from './group-store.js';
import { RedisKeys } from './keys.js';
import { RedisLiveGroups } from './live-groups.js';
import { RedisTimerBackend } from './timers.js';
import { RedisEpoch } from './epoch.js';
import { INSTANCE_TIMINGS, type InstanceTimings, RedisInstance } from './instance.js';
import { LEASE_TIMINGS, type LeaseTimings, RedisLeaseSource } from './lease-lock.js';
import { RedisPubSub } from './pubsub.js';
import { OrphanSweeper } from './sweeper.js';
import { RedisApprovals } from './approvals.js';
import { RedisJoinBudget } from './join-budget.js';
import { RedisParking } from './parking.js';
import { type RedisContext, RedisWorkSource } from './unit-of-work.js';

const MINUTE_MS = 60_000;

export interface RedisStorageOptions {
  link: RedisLink;
  keyPrefix: string;
  scheduler: Scheduler;
  logger: Logger;
  /** The app of a namespace: its max session bounds every key's TTL (#35 AC24). */
  appOf(namespace: string): AppConfig | undefined;
  /** Cap of the ended groups; defaults to MAX_ENDED_GROUPS. Tests lower it. */
  endedGroupsCap?: number;
  /** Test-only: shorter instance and lease timings (#35 architecture 12.13). */
  timings?: Partial<ClusterTimings>;
  /** Test-only: the monotonic clock of the self-fence (default `performance.now`). */
  monotonic?: () => number;
  /** Test-only: runs before every group commit (#35 architecture 12.17, AC18 fence test). */
  beforeCommit?: () => Promise<void>;
}

/** Every several-instance timing (#35 architecture 12.4, 12.5, 12.8; Gate 2 Q-B5). */
export type ClusterTimings = InstanceTimings &
  LeaseTimings & {
    /** How often the orphan sweep runs. */
    sweepMs: number;
    /** How long a claimed group timer is leased (ADR 0013). */
    timerLeaseMs: number;
  };

/** The fixed timings, merged with test overrides. */
export function clusterTimings(overrides: Partial<ClusterTimings> = {}): ClusterTimings {
  return {
    ...INSTANCE_TIMINGS,
    ...LEASE_TIMINGS,
    sweepMs: ORPHAN_SWEEP_MS,
    timerLeaseMs: TIMER_LEASE_MS,
    ...overrides,
  };
}

/** The parts every Redis component shares. */
export function redisContext(options: RedisStorageOptions): RedisContext {
  return {
    link: options.link,
    keys: new RedisKeys(options.keyPrefix),
    logger: options.logger,
    now: () => options.scheduler.now(),
    expiryOf(namespace, createdAt) {
      const app = options.appOf(namespace);
      const minutes = app?.maxSessionMinutes ?? 0;
      return createdAt + minutes * MINUTE_MS + END_TTL_SLACK_MS;
    },
  };
}

/** Storage on one Redis (#35): groups and their unit of work in Redis. */
export function redisStorage(options: RedisStorageOptions): Storage {
  const ctx = redisContext(options);
  const timings = clusterTimings(options.timings);
  const instance = new RedisInstance(ctx, timings, options.monotonic);
  // Security C11: every group-scoped commit requires this instance's liveness.
  ctx.instanceKey = () => instance.liveKey();
  ctx.instanceId = () => (instance.started ? instance.id : undefined);
  ctx.onFencedAbort = () => instance.fence('fenced');
  if (options.beforeCommit !== undefined) ctx.beforeCommit = options.beforeCommit;
  const work = new RedisWorkSource(ctx);
  const leases = new RedisLeaseSource(ctx, timings, () => instance.started && instance.fenced());
  work.leases = leases;
  const resyncListeners: Array<() => void> = [];
  const pubsub = new RedisPubSub({
    link: options.link,
    keys: ctx.keys,
    logger: options.logger,
    instanceId: () => instance.id,
    fenced: () => instance.started && instance.fenced(),
    resync: () => {
      for (const listener of resyncListeners) listener();
    },
  });
  ctx.awaitReceived = (seq) => pubsub.awaitReceived(seq);
  // A fenced instance leaves its channel; under a new ID it joins the new one.
  instance.onFence(() => void pubsub.leave());
  instance.onRegistered((id) => void pubsub.rejoin(id));
  let probeTimer: NodeJS.Timeout | undefined;
  let replay: (() => Promise<void>) | undefined;
  const memory = memoryStorage({ scheduler: options.scheduler, logger: options.logger });
  const timers = new RedisTimerBackend(ctx, work, options.scheduler, timings.timerLeaseMs);
  const epoch = new RedisEpoch(ctx, work);
  const ended = new RedisEndedGroups(ctx, work, options.logger, options.endedGroupsCap);
  const sweeper = new OrphanSweeper(ctx, instance, ended, timings.sweepMs);
  return {
    ...memory,
    kind: 'redis',
    timers,
    epoch,
    keepAttachmentsOnClose: true,
    onRecovered(listener) {
      replay = listener;
      options.link.onState((state) => {
        if (state !== 'connected') return;
        // Queued disconnects first, then the timers that came due meanwhile.
        void listener()
          .then(() => timers.runDue())
          .catch((err: unknown) => {
            options.logger.warn(
              { event: 'redis_recovery_failed', err: safeErr(err) },
              'recovery step failed',
            );
          });
      });
    },
    leases,
    approvals: new RedisApprovals(ctx, work),
    joinBudget: new RedisJoinBudget(ctx),
    parked: new RedisParking(ctx, work),
    cluster: {
      host: {
        selfId: () => work.current()?.instanceId ?? ctx.instanceId?.(),
        registry: (namespace, groupId) => work.current()?.registry(namespace, groupId),
        looksLive: (id) => instance.looksLive(id),
        liveOf: (ids) => instance.liveOf(ids),
        send(target, effect) {
          const running = work.current();
          if (running !== undefined) {
            running.queueRemote(target, effect);
            return;
          }
          // Every group effect comes from a group task; outside one it is dropped.
          options.logger.debug(
            { event: 'remote_effect_dropped', op: effect.op },
            'remote effect outside a task',
          );
        },
      },
      onResync(listener) {
        resyncListeners.push(listener);
      },
      setReceiver(receiver) {
        pubsub.setReceiver(receiver);
      },
      fenced: () => instance.started && instance.fenced(),
      onFence(listener) {
        instance.onFence(() => listener());
      },
    },
    async start(sweep) {
      await epoch.current();
      // Before the sweep and before any commit (#35 architecture 12.8).
      await instance.register();
      instance.start();
      // Subscribe before anything can publish to this instance (12.8).
      await pubsub.start();
      probeTimer = setInterval(() => {
        void pubsub.probe();
        // Each tick also drains the replay queue (busy groups, 12.5).
        if (options.link.state === 'connected' && !instance.fenced()) {
          void replay?.().catch(() => undefined);
        }
      }, timings.heartbeatMs);
      probeTimer.unref();
      // Deadlines that passed while the server was down take effect once (AC12).
      await timers.runDue();
      // Then the attachments of stopped instances (this one before its
      // restart included), and the groups no live instance attends, with
      // the restart grace (AC11, Q-A3). One invalid document never blocks
      // the start: that group ends and stays ended (fails closed, C1).
      const seen = new Set<string>();
      const counts = { invalid: 0, disconnected: 0 };
      await sweeper.sweepDead(sweep, true, seen, counts);
      await sweeper.legacyPass(sweep, seen, counts);
      options.logger.info(
        { event: 'startup_sweep', groups: seen.size, invalid: counts.invalid },
        'restart sweep done',
      );
      timers.startPolling();
      sweeper.start(sweep);
    },
    groups: new RedisGroupStore(ctx, work),
    codes: new RedisCodeIndex(ctx, work),
    liveGroups: new RedisLiveGroups(ctx, work),
    ended,
    doors: new RedisDoorStates(work),
    work,
    status: () => ({
      kind: 'redis',
      // A fenced instance refuses upgrades like an unreachable one (12.5).
      state:
        instance.started && (instance.fenced() || !pubsub.healthy)
          ? 'unreachable'
          : options.link.state,
    }),
    async close() {
      await sweeper.stop();
      clearInterval(probeTimer);
      await pubsub.close();
      await instance.stop();
      await options.link.close();
    },
  };
}
