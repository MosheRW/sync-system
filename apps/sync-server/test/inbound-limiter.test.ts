import { describe, expect, it } from 'vitest';
import { InboundLimiter } from '../src/ws/inbound-limiter.js';
import { TestClock } from './helpers/test-server.js';

describe('InboundLimiter (H3)', () => {
  it('allows a full burst, then refuses', () => {
    const clock = new TestClock();
    const limiter = new InboundLimiter(20, 40, clock.now);
    for (let i = 0; i < 40; i++) expect(limiter.take()).toBe(true);
    expect(limiter.take()).toBe(false);
    expect(limiter.take()).toBe(false);
  });

  it('refills at the configured rate', () => {
    const clock = new TestClock();
    const limiter = new InboundLimiter(20, 40, clock.now);
    for (let i = 0; i < 40; i++) limiter.take();
    clock.advance(50); // 1 token at 20/s
    expect(limiter.take()).toBe(true);
    expect(limiter.take()).toBe(false);
    clock.advance(500); // 10 tokens
    for (let i = 0; i < 10; i++) expect(limiter.take()).toBe(true);
    expect(limiter.take()).toBe(false);
  });

  it('never refills above the burst size', () => {
    const clock = new TestClock();
    const limiter = new InboundLimiter(5, 5, clock.now);
    clock.advance(60_000);
    for (let i = 0; i < 5; i++) expect(limiter.take()).toBe(true);
    expect(limiter.take()).toBe(false);
  });

  it('sustains exactly the refill rate', () => {
    const clock = new TestClock();
    const limiter = new InboundLimiter(20, 20, clock.now);
    for (let i = 0; i < 20; i++) limiter.take();
    let accepted = 0;
    for (let i = 0; i < 100; i++) {
      clock.advance(10); // 100 frames/s offered for 1 s
      if (limiter.take()) accepted += 1;
    }
    // Floating-point refill may land a hair under the 20th token.
    expect(accepted).toBeGreaterThanOrEqual(19);
    expect(accepted).toBeLessThanOrEqual(20);
  });

  it('ignores a clock that goes backwards', () => {
    const clock = new TestClock();
    const limiter = new InboundLimiter(1, 1, clock.now);
    expect(limiter.take()).toBe(true);
    clock.advance(-10_000);
    expect(limiter.take()).toBe(false);
  });
});
