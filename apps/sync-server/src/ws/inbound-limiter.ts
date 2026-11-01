/**
 * Per-connection token bucket over every inbound frame, of any type, before
 * or after the handshake (H3). Refills `ratePerSecond` tokens per second up
 * to `burst`. The clock is injected so tests can control time.
 */
export class InboundLimiter {
  private tokens: number;
  private last: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly now: () => number,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** Takes one token; false when the bucket is empty. */
  take(): boolean {
    const now = this.now();
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.ratePerSecond) / 1000);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
