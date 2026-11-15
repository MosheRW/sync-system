import { describe, expect, it } from 'vitest';
import type { RemoteEffect } from '../src/groups/remote-effects.js';
import { createLogger } from '../src/logging/logger.js';
import type { RedisLink, SubscriberLink } from '../src/storage/redis/connect.js';
import { RedisKeys } from '../src/storage/redis/keys.js';
import { RedisPubSub } from '../src/storage/redis/pubsub.js';
import { LogCapture } from './helpers/log-capture.js';

/** A subscriber link driven by the test. */
class FakeSub implements SubscriberLink {
  readonly listeners = new Map<string, (message: string) => void>();
  state: ((state: 'down' | 'up') => void) | undefined;
  /** What the next PING (probe) does; the default answers at once. */
  probeImpl: () => Promise<boolean> = () => Promise.resolve(true);
  closed = false;

  subscribe(channel: string, listener: (message: string) => void): Promise<void> {
    this.listeners.set(channel, listener);
    return Promise.resolve();
  }
  unsubscribe(channel: string): Promise<void> {
    this.listeners.delete(channel);
    return Promise.resolve();
  }
  probe(): Promise<boolean> {
    return this.probeImpl();
  }
  onState(listener: (state: 'down' | 'up') => void): void {
    this.state = listener;
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  /** Delivers a message with sequence `s` on `channel` (the only one by default). */
  emit(s: number, channel?: string): void {
    const listener =
      channel !== undefined ? this.listeners.get(channel) : [...this.listeners.values()][0];
    listener?.(JSON.stringify({ v: 1, s, effects: [effectOf(s)] }));
  }
}

/** One valid effect that names its sequence (in the group ID) so the test can tell them apart. */
function effectOf(s: number): RemoteEffect {
  return { op: 'forget', ns: 'app-a', gid: String(s).padStart(43, '0') };
}

const tick = async (times = 5) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
};

function setup() {
  const logs = new LogCapture();
  const subs: FakeSub[] = [];
  /** What GET of the sequence key returns next (a string, null, or a pending read). */
  let sequence: () => Promise<unknown> = () => Promise.resolve(null);
  const link = {
    send: (args: readonly string[]) => {
      expect(args[0]).toBe('GET');
      return sequence();
    },
    script: () => Promise.reject(new Error('unused')),
    state: 'connected',
    onState: () => undefined,
    close: () => Promise.resolve(),
    openSubscriber: () => {
      const sub = new FakeSub();
      subs.push(sub);
      return Promise.resolve(sub);
    },
  } as unknown as RedisLink;
  let id = 'a'.repeat(32);
  let resyncs = 0;
  const received: number[] = [];
  const pubsub = new RedisPubSub({
    link,
    keys: new RedisKeys('t'),
    logger: createLogger({ level: 'debug', destination: logs }),
    instanceId: () => id,
    fenced: () => false,
    resync: () => {
      resyncs += 1;
    },
    barrierMs: 60_000,
  });
  pubsub.setReceiver({
    receive(effects) {
      for (const effect of effects) {
        if (effect.op === 'forget') received.push(Number(effect.gid));
      }
    },
  });
  return {
    pubsub,
    subs,
    logs,
    received,
    resyncs: () => resyncs,
    setSequence(next: () => Promise<unknown>) {
      sequence = next;
    },
    setId(next: string) {
      id = next;
    },
  };
}

describe('pub/sub sequence after a resync (#35 security S1)', () => {
  it('resets the last received sequence to the baseline, so a lower one is applied after a reconnect', async () => {
    const t = setup();
    t.setSequence(() => Promise.resolve('1000'));
    await t.pubsub.start();
    const sub = t.subs[0]!;
    // A sequence far above the clock (forged, or before a clock step back).
    sub.emit(9_000_000_000_000_000);
    // The link drops; meanwhile `P:seq` is lost and Redis time is behind.
    sub.state!('down');
    t.setSequence(() => Promise.resolve(null));
    sub.state!('up');
    await tick();
    expect(t.pubsub.healthy).toBe(true);
    sub.emit(500);
    expect(t.received).toEqual([9_000_000_000_000_000, 500]);
    expect(t.logs.find('pubsub_message_stale')).toBeUndefined();
  });

  it('treats a large backwards jump on a live link as a lost link: resync, then a new link', async () => {
    const t = setup();
    await t.pubsub.start();
    const sub = t.subs[0]!;
    sub.emit(10_000_000_000);
    // `P:seq` expired and Redis time is 5000 s behind: every later commit is lower.
    sub.emit(5_000_000_000);
    expect(t.resyncs()).toBe(1);
    expect(t.logs.find('pubsub_link_lost')).toMatchObject({ cause: 'regressed' });
    await tick();
    expect(sub.closed).toBe(true);
    expect(t.subs).toHaveLength(2);
    expect(t.pubsub.healthy).toBe(true);
    // The new link starts from the baseline: the next lower commit is applied.
    t.subs[1]!.emit(5_000_000_001);
    expect(t.received).toEqual([10_000_000_000, 5_000_000_001]);
  });

  it('drops a message slightly older than the last one as stale, without a resync', async () => {
    const t = setup();
    await t.pubsub.start();
    const sub = t.subs[0]!;
    sub.emit(10_000_000_000);
    sub.emit(9_999_999_990);
    expect(t.received).toEqual([10_000_000_000]);
    expect(t.resyncs()).toBe(0);
    expect(t.logs.find('pubsub_message_stale')).toBeDefined();
  });
});
