import type { Cancel, Scheduler } from '../../src/time/scheduler.js';

interface Task {
  id: number;
  at: number;
  run: () => void;
}

/**
 * A manually advanced clock and timer queue. `advance(ms)` moves the clock
 * forward and runs every due task in time order (ties in scheduling order),
 * with `now()` set to each task's time while it runs.
 */
export class ManualScheduler implements Scheduler {
  private tasks: Task[] = [];
  private nextId = 0;

  constructor(public time = 1_767_225_600_000) {}

  now = (): number => this.time;

  at(timeMs: number, run: () => void): Cancel {
    const task: Task = { id: this.nextId++, at: timeMs, run };
    this.tasks.push(task);
    return () => {
      this.tasks = this.tasks.filter((t) => t !== task);
    };
  }

  /** Number of scheduled tasks not yet run or cancelled. */
  get pending(): number {
    return this.tasks.length;
  }

  /** Time of the earliest pending task, if any. */
  get nextAt(): number | undefined {
    return this.sorted()[0]?.at;
  }

  advance(ms: number): void {
    this.advanceTo(this.time + ms);
  }

  advanceTo(target: number): void {
    for (;;) {
      const due = this.sorted().find((task) => task.at <= target);
      if (!due) break;
      this.tasks = this.tasks.filter((t) => t !== due);
      this.time = Math.max(this.time, due.at);
      due.run();
    }
    this.time = Math.max(this.time, target);
  }

  private sorted(): Task[] {
    return [...this.tasks].sort((a, b) => a.at - b.at || a.id - b.id);
  }
}
