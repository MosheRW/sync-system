import type { AppConfig } from '../../apps/app-registry.js';
import { END_TTL_SLACK_MS } from '../../limits/constants.js';
import { type Logger, safeErr } from '../../logging/logger.js';
import type { Scheduler } from '../../time/scheduler.js';
import { StorageInvalidError } from '../errors.js';
import { type Storage, memoryStorage } from '../storage.js';
import type { RedisLink } from './connect.js';
import { RedisCodeIndex } from './codes.js';
import { RedisDoorStates } from './doors.js';
import { RedisEndedGroups } from './ended.js';
import { RedisGroupStore } from './group-store.js';
import { RedisKeys } from './keys.js';
import { RedisTimerBackend } from './timers.js';
import { RedisEpoch } from './epoch.js';
import { INSTANCE_TIMINGS, type InstanceTimings, RedisInstance } from './instance.js';
import { LEASE_TIMINGS, type LeaseTimings, RedisLeaseSource } from './lease-lock.js';
import { RedisPubSub } from './pubsub.js';
import { parseMember } from './keys.js';
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
}

/** Every several-instance timing (#35 architecture 12.4, 12.5; Gate 2 Q-B5). */
export type ClusterTimings = InstanceTimings & LeaseTimings;

/** The fixed timings, merged with test overrides. */
export function clusterTimings(overrides: Partial<ClusterTimings> = {}): ClusterTimings {
  return { ...INSTANCE_TIMINGS, ...LEASE_TIMINGS, ...overrides };
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
  const memory = memoryStorage({ scheduler: options.scheduler, logger: options.logger });
  const timers = new RedisTimerBackend(ctx, work, options.scheduler);
  const epoch = new RedisEpoch(ctx, work);
  const ended = new RedisEndedGroups(ctx, work, options.logger, options.endedGroupsCap);
  return {
    ...memory,
    kind: 'redis',
    timers,
    epoch,
    keepAttachmentsOnClose: true,
    onRecovered(listener) {
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
    cluster: {
      host: {
        selfId: () => work.current()?.instanceId ?? ctx.instanceId?.(),
        registry: (namespace, groupId) => work.current()?.registry(namespace, groupId),
        looksLive: (id) => instance.looksLive(id),
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
      probeTimer = setInterval(() => void pubsub.probe(), timings.heartbeatMs);
      probeTimer.unref();
      // Deadlines that passed while the server was down take effect once (AC12).
      await timers.runDue();
      // Then every live group's attachments from before the stop (AC11).
      const live = await liveGroups(ctx);
      let invalid = 0;
      for (const { namespace, groupId } of live) {
        try {
          await sweep(namespace, groupId);
        } catch (err) {
          if (!(err instanceof StorageInvalidError)) throw err;
          // One invalid document never blocks the start: that group ends
          // and stays ended (fails closed, security C1).
          invalid += 1;
          await ended.endInvalid(namespace, groupId, ctx.expiryOf(namespace, ctx.now()));
        }
      }
      options.logger.info(
        { event: 'startup_sweep', groups: live.length, invalid },
        'restart sweep done',
      );
      timers.startPolling();
    },
    groups: new RedisGroupStore(ctx, work),
    codes: new RedisCodeIndex(ctx, work),
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
      clearInterval(probeTimer);
      await pubsub.close();
      await instance.stop();
      await options.link.close();
    },
  };
}

/** Live groups, by end bound from now (members past it were pruned, F13). */
async function liveGroups(
  ctx: RedisContext,
): Promise<Array<{ namespace: string; groupId: string }>> {
  const found: Array<{ namespace: string; groupId: string }> = [];
  const page = 100;
  for (let offset = 0; ; offset += page) {
    const reply = await ctx.link.send([
      'ZRANGE',
      ctx.keys.live(),
      String(ctx.now()),
      '+inf',
      'BYSCORE',
      'LIMIT',
      String(offset),
      String(page),
    ]);
    const members = Array.isArray(reply) ? (reply as unknown[]).map(String) : [];
    for (const member of members) {
      const parsed = parseMember(member);
      if (parsed !== undefined && parsed.kind === undefined) found.push(parsed);
    }
    if (members.length < page) return found;
  }
}
