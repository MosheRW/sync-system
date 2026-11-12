import type { AppConfig } from '../../apps/app-registry.js';
import { END_TTL_SLACK_MS } from '../../limits/constants.js';
import { type Logger, safeErr } from '../../logging/logger.js';
import type { Scheduler } from '../../time/scheduler.js';
import { type Storage, memoryStorage } from '../storage.js';
import type { RedisLink } from './connect.js';
import { RedisCodeIndex } from './codes.js';
import { RedisDoorStates } from './doors.js';
import { RedisEndedGroups } from './ended.js';
import { RedisGroupStore } from './group-store.js';
import { RedisKeys } from './keys.js';
import { RedisTimerBackend } from './timers.js';
import { RedisEpoch } from './epoch.js';
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
  const work = new RedisWorkSource(ctx);
  const memory = memoryStorage({ scheduler: options.scheduler, logger: options.logger });
  const timers = new RedisTimerBackend(ctx, work, options.scheduler);
  const epoch = new RedisEpoch(ctx, work);
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
    async start(sweep) {
      await epoch.current();
      // Deadlines that passed while the server was down take effect once (AC12).
      await timers.runDue();
      // Then every live group's attachments from before the stop (AC11).
      const live = await liveGroups(ctx);
      for (const { namespace, groupId } of live) await sweep(namespace, groupId);
      options.logger.info({ event: 'startup_sweep', groups: live.length }, 'restart sweep done');
      timers.startPolling();
    },
    groups: new RedisGroupStore(ctx, work),
    codes: new RedisCodeIndex(ctx, work),
    ended: new RedisEndedGroups(ctx, work, options.logger, options.endedGroupsCap),
    doors: new RedisDoorStates(work),
    work,
    status: () => ({ kind: 'redis', state: options.link.state }),
    close: () => options.link.close(),
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
