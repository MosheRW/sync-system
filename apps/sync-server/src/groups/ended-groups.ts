import { createHash } from 'node:crypto';
import { MAX_ENDED_GROUPS } from '../limits/constants.js';

/** Hashed ref of a group: 16 bytes of sha256 as hex (L4). Never the raw ID. */
function refOf(namespace: string, groupId: string): string {
  return createHash('sha256').update(`${namespace}:${groupId}`, 'utf8').digest('hex').slice(0, 32);
}

export interface EvictionLogger {
  warn(obj: object, msg: string): void;
}

/** Most frequent eviction warning: once per minute (L4). */
const EVICTION_WARN_INTERVAL_MS = 60_000;

/**
 * Groups that ended in this process (Q8), remembered as hashed refs until
 * their max-session deadline, so checks and resumes for them get `ended` and
 * a stale leader token cannot recreate them. In memory only: a restart
 * forgets them (accepted risk). Bounded: at the cap the oldest ref is evicted
 * first, and evictions are reported as a count at most once a minute.
 */
export class EndedGroups {
  /** ref -> deadline (epoch ms). Insertion order approximates age. */
  private readonly refs = new Map<string, number>();
  private evicted = 0;
  private lastWarnAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly now: () => number,
    private readonly logger: EvictionLogger,
    private readonly cap: number = MAX_ENDED_GROUPS,
  ) {}

  get size(): number {
    return this.refs.size;
  }

  remember(namespace: string, groupId: string, deadline: number): void {
    if (deadline <= this.now()) return;
    const ref = refOf(namespace, groupId);
    this.refs.delete(ref);
    while (this.refs.size >= this.cap) {
      const oldest = this.refs.keys().next().value;
      if (oldest === undefined) break;
      this.refs.delete(oldest);
      this.evicted += 1;
    }
    this.refs.set(ref, deadline);
    this.warnEvictions();
  }

  has(namespace: string, groupId: string): boolean {
    const ref = refOf(namespace, groupId);
    const deadline = this.refs.get(ref);
    if (deadline === undefined) return false;
    if (deadline <= this.now()) {
      this.refs.delete(ref);
      return false;
    }
    return true;
  }

  /** Drops refs whose deadline has passed. */
  sweep(): void {
    const now = this.now();
    for (const [ref, deadline] of this.refs) {
      if (deadline <= now) this.refs.delete(ref);
    }
  }

  private warnEvictions(): void {
    if (this.evicted === 0) return;
    const now = this.now();
    if (now - this.lastWarnAt < EVICTION_WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    this.logger.warn(
      { event: 'ended_groups_evicting', count: this.evicted },
      'ended-group memory is full; evicting the oldest entries',
    );
    this.evicted = 0;
  }
}
