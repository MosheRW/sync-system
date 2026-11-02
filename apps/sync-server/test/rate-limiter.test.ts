import { describe, expect, it } from 'vitest';
import { SlidingWindowRateLimiter } from '../src/limits/rate-limiter.js';
import { TestClock } from './helpers/test-server.js';

describe('SlidingWindowRateLimiter (AC22)', () => {
  it('accepts up to the limit in a window, then rejects with retryAfterMs', () => {
    const clock = new TestClock();
    const limiter = new SlidingWindowRateLimiter(clock.now);
    for (let i = 0; i < 5; i++) expect(limiter.tryAcquire('g', 5)).toEqual({ ok: true });
    expect(limiter.tryAcquire('g', 5)).toEqual({ ok: false, retryAfterMs: 1000 });
    clock.advance(300);
    expect(limiter.tryAcquire('g', 5)).toEqual({ ok: false, retryAfterMs: 700 });
  });

  it('accepts again once the oldest event leaves the window', () => {
    const clock = new TestClock();
    const limiter = new SlidingWindowRateLimiter(clock.now);
    limiter.tryAcquire('g', 2);
    clock.advance(500);
    limiter.tryAcquire('g', 2);
    expect(limiter.tryAcquire('g', 2).ok).toBe(false);
    clock.advance(499);
    expect(limiter.tryAcquire('g', 2).ok).toBe(false);
    clock.advance(1);
    expect(limiter.tryAcquire('g', 2).ok).toBe(true);
    expect(limiter.tryAcquire('g', 2).ok).toBe(false);
  });

  it('does not count rejected attempts', () => {
    const clock = new TestClock();
    const limiter = new SlidingWindowRateLimiter(clock.now);
    for (let i = 0; i < 5; i++) limiter.tryAcquire('g', 5);
    for (let i = 0; i < 50; i++) expect(limiter.tryAcquire('g', 5).ok).toBe(false);
    clock.advance(1000);
    for (let i = 0; i < 5; i++) expect(limiter.tryAcquire('g', 5).ok).toBe(true);
  });

  it('keeps keys independent and can forget a key', () => {
    const clock = new TestClock();
    const limiter = new SlidingWindowRateLimiter(clock.now);
    limiter.tryAcquire('a', 1);
    expect(limiter.tryAcquire('b', 1).ok).toBe(true);
    expect(limiter.tryAcquire('a', 1).ok).toBe(false);
    limiter.forget('a');
    expect(limiter.tryAcquire('a', 1).ok).toBe(true);
    limiter.forget('a');
    limiter.forget('b');
    expect(limiter.size).toBe(0);
  });

  it('clear() forgets every key (#7 AC6)', () => {
    const clock = new TestClock();
    const limiter = new SlidingWindowRateLimiter(clock.now);
    limiter.tryAcquire('a', 1);
    limiter.tryAcquire('b', 1);
    expect(limiter.size).toBe(2);
    limiter.clear();
    expect(limiter.size).toBe(0);
    expect(limiter.tryAcquire('a', 1)).toEqual({ ok: true });
  });
});
