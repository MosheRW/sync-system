import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  INSTANCE_HEARTBEAT_MS,
  INSTANCE_LIST_RETENTION_MS,
  INSTANCE_LIVENESS_MS,
  INSTANCE_SELF_FENCE_MS,
} from '../../limits/constants.js';
import { safeErr } from '../../logging/logger.js';
import { INSTANCE_ID_PATTERN } from './keys.js';
import {
  DEAD_INSTANCES,
  FORGET_INSTANCE,
  INSTANCE_HEARTBEAT,
  INSTANCE_REGISTER,
  INSTANCE_STOP,
} from './scripts.js';
import type { RedisContext } from './unit-of-work.js';

/** The liveness timings (#35 architecture 12.5, Gate 2 Q-B5); tests shorten them. */
export interface InstanceTimings {
  /** How long the liveness key lives after a renewal. */
  livenessMs: number;
  /** How often it is renewed. */
  heartbeatMs: number;
  /** No successful renewal sent for this long: fence. Below `livenessMs`. */
  selfFenceMs: number;
}

export const INSTANCE_TIMINGS: InstanceTimings = {
  livenessMs: INSTANCE_LIVENESS_MS,
  heartbeatMs: INSTANCE_HEARTBEAT_MS,
  selfFenceMs: INSTANCE_SELF_FENCE_MS,
};

/** Why an instance fenced itself (logged). */
export type FenceReason = 'fenced' | 'silence';

/** A new instance ID: 16 bytes from the CSPRNG, hex (#35 security C16). */
export function newInstanceId(): string {
  return randomBytes(16).toString('hex');
}

/** What logs carry instead of an instance ID (#35 security P2-4, AC25). */
export function instanceRef(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 8);
}

/** Dead instances listed per sweep at most. */
const DEAD_BATCH = 100;

/**
 * This process as one of several instances on one Redis (#35 architecture
 * 12.5, security P2-3, C11). It registers a liveness key under a random ID
 * and renews it; a renewal that finds the key gone, or no successful
 * renewal sent within `selfFenceMs` (monotonic clock), fences the
 * instance: its listeners close every group session before any peer may
 * treat it as dead (the key outlives the last successful send by
 * `livenessMs` > `selfFenceMs`). When Redis answers again, it registers
 * under a new ID; an ID is never reused.
 */
export class RedisInstance {
  private current = newInstanceId();
  private state: 'idle' | 'live' | 'fenced' | 'stopped' = 'idle';
  /** Monotonic send time of the last successful registration or renewal. */
  private lastOkSentAt = Number.NEGATIVE_INFINITY;
  private live = new Set<string>();
  private heartbeat: NodeJS.Timeout | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  private ticking = false;
  /** Set by the first registration: from then on every commit is fenced. */
  private registeredOnce = false;
  private readonly fenceListeners: Array<(reason: FenceReason) => void> = [];
  private readonly registerListeners: Array<(id: string) => void> = [];

  constructor(
    private readonly ctx: RedisContext,
    private readonly timings: InstanceTimings = INSTANCE_TIMINGS,
    private readonly monotonic: () => number = () => performance.now(),
  ) {}

  /** The current instance ID (never logged; see `ref`). */
  get id(): string {
    return this.current;
  }

  /** The current ID's log reference. */
  get ref(): string {
    return instanceRef(this.current);
  }

  /**
   * The liveness key the commits of this instance require (security C11);
   * undefined before the first registration (storage not started: tests).
   */
  liveKey(): string | undefined {
    return this.registeredOnce ? this.ctx.keys.instance(this.current) : undefined;
  }

  /** True once the instance registered (the server started). */
  get started(): boolean {
    return this.registeredOnce;
  }

  /**
   * True when this instance must not act: it fenced itself, stopped, or no
   * renewal it sent succeeded within `selfFenceMs` (security C11, the
   * synchronous guard).
   */
  fenced(): boolean {
    if (this.state !== 'live') return true;
    return this.monotonic() - this.lastOkSentAt >= this.timings.selfFenceMs;
  }

  /** Whether `id` looked alive at the last renewal (a hint only, security C12). */
  looksLive(id: string): boolean {
    return id === this.current ? this.state === 'live' : this.live.has(id);
  }

  /** Called when the instance fences itself. */
  onFence(listener: (reason: FenceReason) => void): void {
    this.fenceListeners.push(listener);
  }

  /** Called with the new ID after a registration under a new ID (after a fence). */
  onRegistered(listener: (id: string) => void): void {
    this.registerListeners.push(listener);
  }

  /** Registers at startup (throws when Redis fails, a startup error). */
  async register(): Promise<void> {
    const sentAt = this.monotonic();
    const ok = await this.ctx.link.script(
      INSTANCE_REGISTER,
      [this.ctx.keys.instance(this.current), this.ctx.keys.instances()],
      [this.current, String(this.timings.livenessMs), String(INSTANCE_LIST_RETENTION_MS)],
    );
    if (Number(ok) !== 1) throw new Error('instance id taken');
    this.lastOkSentAt = sentAt;
    this.state = 'live';
    this.registeredOnce = true;
    this.live.add(this.current);
    this.ctx.logger.info({ event: 'instance_registered', instanceRef: this.ref }, 'instance up');
  }

  /** Starts the renewals and the self-fence watchdog. */
  start(): void {
    if (this.heartbeat !== undefined) return;
    this.heartbeat = setInterval(() => void this.tick(), this.timings.heartbeatMs);
    this.heartbeat.unref();
    const every = Math.max(20, Math.min(1_000, Math.floor(this.timings.selfFenceMs / 5)));
    this.watchdog = setInterval(() => {
      if (this.state === 'live' && this.fenced()) this.fence('silence');
    }, every);
    this.watchdog.unref();
  }

  /** One renewal, or, while fenced, one registration under a new ID. */
  private async tick(): Promise<void> {
    if (this.ticking || this.state === 'stopped' || this.state === 'idle') return;
    this.ticking = true;
    try {
      if (this.state === 'fenced') await this.reregister();
      else await this.renew();
    } finally {
      this.ticking = false;
    }
  }

  private async renew(): Promise<void> {
    const id = this.current;
    const sentAt = this.monotonic();
    let reply: unknown;
    try {
      reply = await this.ctx.link.script(
        INSTANCE_HEARTBEAT,
        [this.ctx.keys.instance(id), this.ctx.keys.instances()],
        [id, String(this.timings.livenessMs)],
      );
    } catch {
      // No renewal: the watchdog fences once selfFenceMs passed.
      return;
    }
    if (this.state !== 'live' || id !== this.current) return;
    const items = Array.isArray(reply) ? (reply as unknown[]).map(String) : [];
    if (items[0] !== '1') {
      this.fence('fenced');
      return;
    }
    // A renewal that arrives after the watchdog fenced does not unfence.
    if (this.fenced()) return;
    this.lastOkSentAt = Math.max(this.lastOkSentAt, sentAt);
    this.live = new Set(items.slice(1).filter((item) => INSTANCE_ID_PATTERN.test(item)));
  }

  private async reregister(): Promise<void> {
    this.current = newInstanceId();
    this.state = 'idle';
    try {
      await this.register();
    } catch {
      this.state = 'fenced';
      return;
    }
    for (const listener of this.registerListeners) listener(this.current);
  }

  /** Fences now (a commit found the liveness key gone, or the watchdog fired). */
  fence(reason: FenceReason): void {
    if (this.state !== 'live') return;
    this.state = 'fenced';
    this.live = new Set();
    this.ctx.logger.warn(
      { event: 'instance_fenced', instanceRef: this.ref, cause: reason },
      'instance fenced itself',
    );
    for (const listener of this.fenceListeners) {
      try {
        listener(reason);
      } catch (err) {
        this.ctx.logger.error({ event: 'fence_error', err: safeErr(err) }, 'fence step failed');
      }
    }
  }

  /**
   * Which of `ids` still have their liveness key, read from Redis now (the
   * truth for removals, security C12).
   */
  async liveOf(ids: readonly string[]): Promise<Set<string>> {
    const checked = [...new Set(ids)].filter((id) => INSTANCE_ID_PATTERN.test(id));
    if (checked.length === 0) return new Set();
    const reply = await this.ctx.link.send([
      'MGET',
      ...checked.map((id) => this.ctx.keys.instance(id)),
    ]);
    const values = Array.isArray(reply) ? (reply as unknown[]) : [];
    return new Set(checked.filter((_id, i) => values[i] !== null && values[i] !== undefined));
  }

  /** Instances whose deadline passed and whose liveness key is gone (#35 architecture 12.8). */
  async deadInstances(): Promise<string[]> {
    const reply = await this.ctx.link.script(
      DEAD_INSTANCES,
      [this.ctx.keys.instances()],
      [`${this.ctx.keys.base}:inst:`, String(DEAD_BATCH)],
    );
    const ids = Array.isArray(reply) ? (reply as unknown[]).map(String) : [];
    return ids.filter((id) => INSTANCE_ID_PATTERN.test(id) && id !== this.current);
  }

  /** Forgets a swept instance, only while its liveness key is absent. */
  async forget(id: string): Promise<boolean> {
    const { keys } = this.ctx;
    const reply = await this.ctx.link.script(
      FORGET_INSTANCE,
      [keys.instance(id), keys.instanceGroups(id), keys.instances()],
      [id],
    );
    return Number(reply) === 1;
  }

  /**
   * A clean stop (#35 architecture 12.5): renewals stop and the liveness
   * key goes, so a peer sweeps the stored attachments within a tick.
   */
  async stop(): Promise<void> {
    const wasLive = this.state === 'live';
    this.state = 'stopped';
    clearInterval(this.heartbeat);
    clearInterval(this.watchdog);
    this.heartbeat = undefined;
    this.watchdog = undefined;
    if (!wasLive) return;
    try {
      await this.ctx.link.script(
        INSTANCE_STOP,
        [this.ctx.keys.instance(this.current), this.ctx.keys.instances()],
        [this.current],
      );
    } catch {
      // The key expires with its TTL.
    }
  }
}
