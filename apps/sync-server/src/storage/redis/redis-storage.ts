import type { AppConfig } from '../../apps/app-registry.js';
import { END_TTL_SLACK_MS } from '../../limits/constants.js';
import type { Logger } from '../../logging/logger.js';
import type { Scheduler } from '../../time/scheduler.js';
import { type Storage, memoryStorage } from '../storage.js';
import type { RedisLink } from './connect.js';
import { RedisCodeIndex } from './codes.js';
import { RedisDoorStates } from './doors.js';
import { RedisEndedGroups } from './ended.js';
import { RedisGroupStore } from './group-store.js';
import { RedisKeys } from './keys.js';
import { RedisTimerBackend } from './timers.js';
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
  return {
    ...memory,
    kind: 'redis',
    timers,
    async start() {
      // Deadlines that passed while the server was down take effect once (AC12).
      await timers.runDue();
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
