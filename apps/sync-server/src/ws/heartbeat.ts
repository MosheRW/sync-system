import { randomBytes } from 'node:crypto';

/** What the heartbeat needs from a connection (fakeable in unit tests). */
export interface HeartbeatTarget {
  /** True while a ping is outstanding. */
  awaitingPong: boolean;
  /** Random payload of the outstanding ping; a valid pong echoes it. */
  pingPayload: Buffer | undefined;
  /** bufferedAmount recorded at the previous tick. */
  lastBufferedAmount: number;
  readonly bufferedAmount: number;
  ping(payload: Buffer): void;
  terminate(): void;
}

export type TickResult = 'pinged' | 'no_pong' | 'stuck_buffer';

/**
 * One heartbeat step for one socket (H2, AC17):
 * - a ping still outstanding from the last tick: terminate;
 * - a non-zero outbound buffer that has not dropped since the last tick:
 *   terminate (the peer is not reading);
 * - otherwise record the buffer, mark a ping outstanding and ping.
 */
export function heartbeatTick(target: HeartbeatTarget): TickResult {
  if (target.awaitingPong) {
    target.terminate();
    return 'no_pong';
  }
  const buffered = target.bufferedAmount;
  if (buffered > 0 && target.lastBufferedAmount > 0 && buffered >= target.lastBufferedAmount) {
    target.terminate();
    return 'stuck_buffer';
  }
  target.lastBufferedAmount = buffered;
  target.awaitingPong = true;
  target.pingPayload = randomBytes(8);
  target.ping(target.pingPayload);
  return 'pinged';
}

/**
 * A pong counts only while a ping is outstanding and only if it echoes that
 * ping's random payload, so unsolicited pongs (allowed by RFC 6455) cannot
 * keep a socket alive.
 */
export function heartbeatPong(target: HeartbeatTarget, data: Buffer): void {
  if (!target.awaitingPong || !target.pingPayload?.equals(data)) return;
  target.awaitingPong = false;
  target.pingPayload = undefined;
}

export class Heartbeat {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly targets: () => Iterable<HeartbeatTarget>,
    private readonly onTerminate: (result: Exclude<TickResult, 'pinged'>) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  tick(): void {
    for (const target of [...this.targets()]) {
      const result = heartbeatTick(target);
      if (result !== 'pinged') this.onTerminate(result);
    }
  }
}
