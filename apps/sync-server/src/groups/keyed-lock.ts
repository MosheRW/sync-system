/**
 * Per-key async mutex: tasks for the same key run one at a time in call
 * order; different keys never wait for each other. Idle keys are dropped,
 * so memory is bounded by the keys with work in flight. Process-local: a
 * multi-instance store needs its own atomicity.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  /** Number of keys with a task running or waiting. For tests only. */
  get size(): number {
    return this.tails.size;
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The chain only ever resolves, so a failed task never blocks the next.
    const tail = previous.then(() => done);
    this.tails.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
