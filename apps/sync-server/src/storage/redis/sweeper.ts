import { safeErr } from '../../logging/logger.js';
import { StorageBusyError, StorageInvalidError } from '../errors.js';
import type { RedisEndedGroups } from './ended.js';
import type { RedisInstance } from './instance.js';
import { parseMember } from './keys.js';
import { type RedisContext, readGroup } from './unit-of-work.js';

/** Sweeps one group under its lease; returns how many it disconnected. */
export type SweepGroup = (namespace: string, groupId: string, restart: boolean) => Promise<number>;

/** Members read per SSCAN step (a cursor, never a pattern scan, security C6). */
const SCAN_COUNT = 100;
/** Live groups read per page by the startup pass. */
const PAGE = 100;

/**
 * The orphan sweep (#35 architecture 12.8, AC21, AC11, security C12):
 * attachments of instances that stopped or died are disconnected with the
 * usual rules. Periodic: dead instances (liveness key gone, Redis time),
 * then each of their groups by cursor, then the instance is forgotten.
 * At startup also a pass over every live group for groups written by PR 1
 * (no registry) and groups nobody alive attends. Idempotent, so sweepers
 * on several instances only repeat no-ops.
 */
export class OrphanSweeper {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly ctx: RedisContext,
    private readonly instance: RedisInstance,
    private readonly ended: RedisEndedGroups,
    private readonly sweepMs: number,
  ) {}

  /** Runs the sweep of one group; an invalid stored group ends (fails closed, C1). */
  private async group(
    sweep: SweepGroup,
    namespace: string,
    groupId: string,
    restart: boolean,
    counts: { invalid: number; disconnected: number },
  ): Promise<void> {
    try {
      counts.disconnected += await sweep(namespace, groupId, restart);
    } catch (err) {
      if (!(err instanceof StorageInvalidError)) throw err;
      counts.invalid += 1;
      await this.ended.endInvalid(namespace, groupId, this.ctx.expiryOf(namespace, this.ctx.now()));
    }
  }

  /**
   * Sweeps every group of every dead instance, then forgets the instance
   * (only once all its groups were swept). Returns the instances and groups.
   */
  async sweepDead(
    sweep: SweepGroup,
    restart: boolean,
    seen: Set<string>,
    counts: { invalid: number; disconnected: number },
  ): Promise<number> {
    const dead = await this.instance.deadInstances();
    for (const id of dead) {
      let complete = true;
      let cursor = '0';
      do {
        const reply = await this.ctx.link.send([
          'SSCAN',
          this.ctx.keys.instanceGroups(id),
          cursor,
          'COUNT',
          String(SCAN_COUNT),
        ]);
        const [next, members] = Array.isArray(reply) ? (reply as unknown[]) : [];
        cursor = typeof next === 'string' ? next : '0';
        for (const member of Array.isArray(members) ? (members as unknown[]).map(String) : []) {
          const parsed = parseMember(member);
          if (parsed === undefined || parsed.kind !== undefined) continue;
          seen.add(member);
          try {
            await this.group(sweep, parsed.namespace, parsed.groupId, restart, counts);
          } catch (err) {
            // Another instance holds the group: the next tick tries again.
            if (!(err instanceof StorageBusyError)) throw err;
            complete = false;
          }
        }
      } while (cursor !== '0');
      if (complete) await this.instance.forget(id);
    }
    return dead.length;
  }

  /**
   * The startup pass (#35 architecture 12.8): every live group, with a
   * check outside the lease; the lease is taken only for a group with a
   * connected participant that no live instance holds (PR 1 groups have no
   * registry), or a running pause that no live instance attends (Q-A3).
   */
  async legacyPass(
    sweep: SweepGroup,
    seen: Set<string>,
    counts: { invalid: number; disconnected: number },
  ): Promise<void> {
    for (let offset = 0; ; offset += PAGE) {
      const reply = await this.ctx.link.send([
        'ZRANGE',
        this.ctx.keys.live(),
        String(this.ctx.now()),
        '+inf',
        'BYSCORE',
        'LIMIT',
        String(offset),
        String(PAGE),
      ]);
      const members = Array.isArray(reply) ? (reply as unknown[]).map(String) : [];
      for (const member of members) {
        const parsed = parseMember(member);
        if (parsed === undefined || parsed.kind !== undefined) continue;
        seen.add(member);
        const { namespace, groupId } = parsed;
        let needed: boolean;
        try {
          needed = await this.needsSweep(namespace, groupId);
        } catch (err) {
          if (!(err instanceof StorageInvalidError)) throw err;
          needed = true;
        }
        if (needed) await this.group(sweep, namespace, groupId, true, counts);
      }
      if (members.length < PAGE) return;
    }
  }

  private async needsSweep(namespace: string, groupId: string): Promise<boolean> {
    const stored = await readGroup(this.ctx, namespace, groupId);
    if (stored === undefined) return false;
    const { record, registry } = stored;
    const connected = record.participantIds.filter((pid) => pid !== record.leaderId);
    if (record.leaderOnline) connected.push(record.leaderId);
    const named = connected.map((pid) => registry.get(pid)?.i);
    const live = await this.instance.liveOf(named.filter((id) => id !== undefined));
    if (named.some((id) => id === undefined || !live.has(id))) return true;
    // A pause nobody alive attends gets the restart floor (Q-A3).
    return record.pause !== undefined && connected.length === 0;
  }

  /** Starts the periodic sweep, every `sweepMs` with up to 1 s of jitter. */
  start(sweep: SweepGroup): void {
    this.stopped = false;
    const schedule = () => {
      if (this.stopped) return;
      const jitter = Math.min(1_000, Math.floor(this.sweepMs / 5));
      const delay = this.sweepMs - jitter + Math.floor(Math.random() * (2 * jitter + 1));
      this.timer = setTimeout(() => {
        this.running = this.tick(sweep).finally(() => {
          this.running = undefined;
          schedule();
        });
      }, delay);
      this.timer.unref();
    };
    schedule();
  }

  private async tick(sweep: SweepGroup): Promise<void> {
    if (this.ctx.link.state !== 'connected' || this.instance.fenced()) return;
    const counts = { invalid: 0, disconnected: 0 };
    const seen = new Set<string>();
    try {
      const instances = await this.sweepDead(sweep, false, seen, counts);
      if (instances > 0) {
        this.ctx.logger.info(
          { event: 'orphan_sweep', instances, groups: seen.size, invalid: counts.invalid },
          'orphan sweep done',
        );
      }
    } catch (err) {
      this.ctx.logger.warn({ event: 'orphan_sweep_failed', err: safeErr(err) }, 'sweep failed');
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
  }
}
