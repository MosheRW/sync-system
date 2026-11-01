import type { JsonValue } from '@sync-system/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_RATE_LIMIT_RETRY_MS, PositionThrottle } from '../src/throttle.js';

interface Sent {
  at: number;
  value: JsonValue;
}

let sent: Sent[];
let start: number;

function makeThrottle(limit = 5): PositionThrottle<JsonValue> {
  return new PositionThrottle<JsonValue>(limit, (value) =>
    sent.push({ at: Date.now() - start, value }),
  );
}

/** Largest number of sends inside any window of `windowMs`. */
function maxInWindow(windowMs: number): number {
  let max = 0;
  for (const first of sent) {
    const count = sent.filter((s) => s.at >= first.at && s.at < first.at + windowMs).length;
    max = Math.max(max, count);
  }
  return max;
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  start = Date.now();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PositionThrottle (AC21)', () => {
  it('sends at once while under the limit', () => {
    const throttle = makeThrottle(5);
    for (let i = 0; i < 5; i += 1) throttle.submit(i);
    expect(sent.map((s) => s.value)).toEqual([0, 1, 2, 3, 4]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces a burst of 50 in 1 s at 5/s and always ends with the last value', () => {
    const throttle = makeThrottle(5);
    for (let i = 0; i < 50; i += 1) {
      throttle.submit(i);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
      vi.advanceTimersByTime(20);
    }
    vi.advanceTimersByTime(5_000);
    expect(maxInWindow(1_100)).toBeLessThanOrEqual(5);
    expect(sent.at(-1)?.value).toBe(49);
    expect(sent.length).toBeLessThan(50);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps any 1.1 s window at or under the limit for a steady stream', () => {
    const throttle = makeThrottle(3);
    for (let i = 0; i < 200; i += 1) {
      throttle.submit({ page: i });
      vi.advanceTimersByTime(7);
    }
    vi.advanceTimersByTime(5_000);
    expect(maxInWindow(1_100)).toBeLessThanOrEqual(3);
    expect(sent.at(-1)?.value).toEqual({ page: 199 });
  });

  it('cancel drops the pending value and the timer', () => {
    const throttle = makeThrottle(1);
    throttle.submit('a');
    throttle.submit('b');
    expect(throttle.scheduled).toBe(true);
    throttle.cancel();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(sent.map((s) => s.value)).toEqual(['a']);
  });

  it('passes the value through by reference', () => {
    const throttle = makeThrottle(5);
    const value = { nested: [1, { x: null }] };
    throttle.submit(value);
    expect(sent[0]?.value).toBe(value);
  });
});

describe('RATE_LIMITED re-queue (AC23, M1, L5)', () => {
  it('puts the position back after retryAfterMs when nothing newer is pending', () => {
    const throttle = makeThrottle(5);
    throttle.submit('p');
    throttle.rateLimited('p', 300);
    vi.advanceTimersByTime(299);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent.map((s) => s.value)).toEqual(['p', 'p']);
  });

  it('does not re-queue when a newer position is pending', () => {
    const throttle = makeThrottle(1);
    throttle.submit('old');
    throttle.submit('new');
    throttle.rateLimited('old', 10);
    vi.advanceTimersByTime(5_000);
    expect(sent.map((s) => s.value)).toEqual(['old', 'new']);
  });

  it.each([
    ['1e12', 1e12, MAX_RATE_LIMIT_RETRY_MS],
    ['missing', undefined, 0],
    ['0', 0, 0],
  ])('clamps retryAfterMs %s to [slot, 10 s]', (_name, retryAfterMs, expected) => {
    const throttle = makeThrottle(5);
    throttle.submit('p');
    throttle.rateLimited('p', retryAfterMs);
    vi.advanceTimersByTime(Math.max(0, expected - 1));
    if (expected > 0) expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(2);
  });

  it('waits at least for the next window slot', () => {
    const throttle = makeThrottle(1);
    throttle.submit('p');
    throttle.rateLimited('p', 1);
    vi.advanceTimersByTime(1_099);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(2);
  });

  it('re-queues the same position at most 3 times', () => {
    const throttle = makeThrottle(5);
    throttle.submit('p');
    for (let i = 0; i < 6; i += 1) {
      throttle.rateLimited('p', 10);
      vi.advanceTimersByTime(20);
    }
    expect(sent).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
  });
});
