import { randomInt } from 'node:crypto';
import type { RandomInt } from '../../src/joins/codes.js';

/**
 * A code draw source for tests (#10 AC9, AC11): returns queued values first,
 * then real CSPRNG values. `queue(7)` makes the next 6-digit draw `000007`.
 */
export class ScriptedRandom {
  private readonly values: number[] = [];

  /** Values for the next draws, in order. */
  queue(...values: number[]): void {
    this.values.push(...values);
  }

  readonly next: RandomInt = (max) => {
    const value = this.values.shift();
    return value === undefined ? randomInt(max) : value % max;
  };
}
