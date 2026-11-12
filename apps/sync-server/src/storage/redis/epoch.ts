import type { RedisContext, RedisWorkSource } from './unit-of-work.js';

/**
 * When the stored groups' keyspace started (#35 architecture 4.5): the
 * recovery fence of #13 6.9 layer 2 moves from the process to the store.
 * A group missing from Redis whose token was issued at or after the epoch
 * has ended. If Redis comes back empty, the next read sets a new epoch, so
 * older tokens can recreate their groups (AC14).
 */
export interface EpochSource {
  /** The epoch (epoch ms), created if missing. 0 when the stored value is invalid (fails closed, C1). */
  current(): Promise<number>;
  /** Called with every epoch read (the token `iat` floor follows it). */
  follow(listener: (epoch: number) => void): void;
}

const DIGITS = /^[0-9]{1,16}$/;

export class RedisEpoch implements EpochSource {
  private listener: (epoch: number) => void = () => undefined;

  constructor(
    private readonly ctx: RedisContext,
    private readonly work: RedisWorkSource,
  ) {}

  follow(listener: (epoch: number) => void): void {
    this.listener = listener;
  }

  async current(): Promise<number> {
    const raw = await this.read();
    // Fail closed: every token is "from this epoch", so no recreation.
    if (raw === undefined) return 0;
    const epoch = Number(raw);
    this.work.current()?.seeEpoch(raw);
    this.listener(epoch);
    return epoch;
  }

  /** The stored epoch text, created if missing; undefined when invalid (logged, C1). */
  async read(): Promise<string | undefined> {
    const key = this.ctx.keys.epoch();
    let raw = await this.ctx.link.send(['GET', key]);
    if (raw === null || raw === undefined) {
      await this.ctx.link.send(['SET', key, String(this.ctx.now()), 'NX']);
      raw = await this.ctx.link.send(['GET', key]);
    }
    if (typeof raw !== 'string' || !DIGITS.test(raw)) {
      this.ctx.logger.error({ event: 'store_document_invalid' }, 'stored epoch is invalid');
      return undefined;
    }
    return raw;
  }
}
