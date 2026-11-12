import { createHash } from 'node:crypto';
import { MAX_ENDED_GROUPS } from '../limits/constants.js';

/** Hashed ref of a group: 16 bytes of sha256 as hex (L4). Never the raw ID. */
export function endedRef(namespace: string, groupId: string): string {
  return createHash('sha256').update(`${namespace}:${groupId}`, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Ended groups as hashed refs (#13 6.9), async so the Redis store can keep
 * them across a restart (#35 AC13). `remember` follows the layer 3 eviction
 * and closure rules of `EndedGroups` in both stores.
 */
export interface EndedGroupsStore {
  remember(
    namespace: string,
    groupId: string,
    deadline: number,
    guardUntil?: number,
  ): Promise<void>;
  has(namespace: string, groupId: string): Promise<boolean>;
  isRecoveryClosed(namespace: string): Promise<boolean>;
  /** Drops passed entries and closures. */
  sweep(): Promise<void>;
}

export interface EvictionLogger {
  warn(obj: object, msg: string): void;
}

/** Most frequent eviction and closure warning: once per minute each (L4, #13 6.9). */
const WARN_INTERVAL_MS = 60_000;

interface Entry {
  /** Max-session deadline of the group (epoch ms): the TTL of the entry. */
  deadline: number;
  namespace: string;
  /**
   * Only for a group recreated in this process (#13 6.9 layer 1): until
   * then, a pre-restart leader token of the group could still recreate it,
   * so the entry must not be evicted without closing recovery.
   */
  guardUntil?: number;
}

/**
 * Groups that ended in this process (Q8, #13 D15), remembered as hashed refs
 * until their max-session deadline, so checks and resumes for them get
 * `ended` and no token can recreate them. In memory only: a restart forgets
 * them (accepted risk).
 *
 * Bounded, failing closed (#13 6.9 layer 3, RC17, RC20). Entries live in two
 * insertion-ordered maps, plain and guarded. At the cap:
 * (a) the oldest plain entry, or a guarded one whose guard has passed, goes
 *     first (tokens of a group created here are covered by the `iat` fence;
 *     pre-restart leader tokens of a recreated group are `lat`-expired once
 *     the guard passed);
 * (b) only if there is none, the oldest guarded entry of the namespace that
 *     holds the most guarded entries goes, and recovery of that namespace is
 *     closed until the entry's guard (`isRecoveryClosed`), so the closure
 *     lands on a flooding app, not on others (M5).
 */
export class EndedGroups {
  /** ref -> entry without a guard. Insertion order approximates age. */
  private readonly plain = new Map<string, Entry>();
  /** ref -> entry with a guard. Insertion order approximates age. */
  private readonly guarded = new Map<string, Entry>();
  /** Guarded entries per namespace (RC20). */
  private readonly guardedPerNamespace = new Map<string, number>();
  /** namespace -> closed until (epoch ms). Bounded by the number of apps. */
  private readonly closedUntil = new Map<string, number>();
  private evicted = 0;
  private lastWarnAt = Number.NEGATIVE_INFINITY;
  private readonly closureWarnedAt = new Map<string, number>();

  constructor(
    private readonly now: () => number,
    private readonly logger: EvictionLogger,
    private readonly cap: number = MAX_ENDED_GROUPS,
  ) {}

  get size(): number {
    return this.plain.size + this.guarded.size;
  }

  /**
   * Remembers an ended group until `deadline`. `guardUntil` is set only for
   * a group recreated in this process (#13 6.9 layer 1).
   */
  remember(namespace: string, groupId: string, deadline: number, guardUntil?: number): void {
    const now = this.now();
    if (deadline <= now) return;
    const ref = endedRef(namespace, groupId);
    this.drop(ref);
    while (this.size >= this.cap) {
      if (!this.evictOne(now)) break;
    }
    const entry: Entry = { deadline, namespace };
    if (guardUntil !== undefined && guardUntil > now) {
      entry.guardUntil = guardUntil;
      this.guarded.set(ref, entry);
      this.guardedPerNamespace.set(namespace, (this.guardedPerNamespace.get(namespace) ?? 0) + 1);
    } else {
      this.plain.set(ref, entry);
    }
    this.warnEvictions();
  }

  has(namespace: string, groupId: string): boolean {
    const ref = endedRef(namespace, groupId);
    const entry = this.plain.get(ref) ?? this.guarded.get(ref);
    if (entry === undefined) return false;
    if (entry.deadline <= this.now()) {
      this.drop(ref);
      return false;
    }
    return true;
  }

  /**
   * True while recovery of `namespace` is closed because a guarded entry had
   * to be evicted (#13 6.9 layer 3 (b)): every token of that namespace for a
   * group not in memory is then `ended`.
   */
  isRecoveryClosed(namespace: string): boolean {
    const until = this.closedUntil.get(namespace);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.closedUntil.delete(namespace);
      return false;
    }
    return true;
  }

  /** Drops entries whose deadline has passed, and passed closures. */
  sweep(): void {
    const now = this.now();
    for (const [ref, entry] of [...this.plain, ...this.guarded]) {
      if (entry.deadline <= now) this.drop(ref);
    }
    for (const [namespace, until] of this.closedUntil) {
      if (until <= now) this.closedUntil.delete(namespace);
    }
  }

  /** Evicts one entry in the 6.9 order. False when nothing could be evicted. */
  private evictOne(now: number): boolean {
    const oldestPlain = this.plain.keys().next().value;
    if (oldestPlain !== undefined) {
      this.drop(oldestPlain);
      this.evicted += 1;
      return true;
    }
    for (const [ref, entry] of this.guarded) {
      if ((entry.guardUntil ?? 0) <= now) {
        this.drop(ref);
        this.evicted += 1;
        return true;
      }
    }
    const namespace = this.busiestGuardedNamespace();
    if (namespace === undefined) return false;
    for (const [ref, entry] of this.guarded) {
      if (entry.namespace !== namespace) continue;
      this.drop(ref);
      this.evicted += 1;
      const until = Math.max(this.closedUntil.get(namespace) ?? 0, entry.guardUntil ?? 0);
      this.closedUntil.set(namespace, until);
      this.warnClosure(namespace, now);
      return true;
    }
    return false;
  }

  /** The namespace with the most guarded entries (ties: the first seen). */
  private busiestGuardedNamespace(): string | undefined {
    let best: string | undefined;
    let most = 0;
    for (const [namespace, count] of this.guardedPerNamespace) {
      if (count > most) {
        best = namespace;
        most = count;
      }
    }
    return best;
  }

  private drop(ref: string): void {
    this.plain.delete(ref);
    const entry = this.guarded.get(ref);
    if (entry === undefined) return;
    this.guarded.delete(ref);
    const count = (this.guardedPerNamespace.get(entry.namespace) ?? 1) - 1;
    if (count <= 0) this.guardedPerNamespace.delete(entry.namespace);
    else this.guardedPerNamespace.set(entry.namespace, count);
  }

  private warnClosure(namespace: string, now: number): void {
    const last = this.closureWarnedAt.get(namespace);
    if (last !== undefined && now - last < WARN_INTERVAL_MS) return;
    this.closureWarnedAt.set(namespace, now);
    this.logger.warn(
      { event: 'ended_groups_recovery_closed', namespace },
      'ended-group memory is full of guarded entries; recovery closed for the app',
    );
  }

  private warnEvictions(): void {
    if (this.evicted === 0) return;
    const now = this.now();
    if (now - this.lastWarnAt < WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    this.logger.warn(
      { event: 'ended_groups_evicting', count: this.evicted },
      'ended-group memory is full; evicting the oldest entries',
    );
    this.evicted = 0;
  }
}
