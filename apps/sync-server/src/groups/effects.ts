/**
 * Session effects of one locked group task, in call order (#35 ADR 0011):
 * frames to deliver, `afterPending` tasks and socket closes. They are
 * flushed only after the task's state is committed, so a failed commit
 * never shows a client a change that was not stored (no oracle). On the
 * in-memory store the commit cannot fail, so the flush keeps today's order.
 */
export class EffectOutbox {
  private queue: Array<() => void> = [];

  get size(): number {
    return this.queue.length;
  }

  add(effect: () => void): void {
    this.queue.push(effect);
  }

  /** Runs every queued effect in order. Effects never throw (sessions guard their sockets). */
  flush(): void {
    const queued = this.queue;
    this.queue = [];
    for (const effect of queued) effect();
  }

  /** Forgets every queued effect (failed commit). */
  drop(): void {
    this.queue = [];
  }
}
