import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  /** PINGs sent on this link (the baseline's included). */
  pings = 0;
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
    this.pings += 1;
    return this.probeImpl();
  }
  onState(listener: (state: 'down' | 'up') => void): void {
    this.state = listener;
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  /** Delivers a message with sequence `s` on the only channel. */
  emit(s: number): void {
    const listener = [...this.listeners.values()][0];
    listener?.(JSON.stringify({ v: 1, s, effects: [effectOf(s)] }));
  }
  /** Every later PING stays pending until the test settles it. */
  hold(): Array<Deferred<boolean>> {
    const pending: Array<Deferred<boolean>> = [];
    this.probeImpl = () => {
      const next = deferred<boolean>();
      pending.push(next);
      return next.promise;
    };
    return pending;
  }
}

function effectOf(s: number): RemoteEffect {
  return { op: 'forget', ns: 'app-a', gid: String(s).padStart(43, '0') };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = async (times = 5) => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setImmediate(resolve));
};

function setup() {
  const logs = new LogCapture();
  const subs: FakeSub[] = [];
  const link = {
    send: (args: readonly string[]) => {
      expect(args[0]).toBe('GET');
      return Promise.resolve(null);
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
  let resyncs = 0;
  const pubsub = new RedisPubSub({
    link,
    keys: new RedisKeys('t'),
    logger: createLogger({ level: 'debug', destination: logs }),
    instanceId: () => 'a'.repeat(32),
    fenced: () => false,
    resync: () => {
      resyncs += 1;
    },
    barrierMs: 60_000,
  });
  pubsub.setReceiver({ receive: () => undefined });
  const lost = () => logs.records().filter((record) => record.event === 'pubsub_link_lost');
  return { pubsub, subs, logs, lost, resyncs: () => resyncs };
}

/** Replaces the link from another path than the probe: the sequence jumps far back (S1). */
function regress(sub: FakeSub): void {
  sub.emit(10_000_000_000);
  sub.emit(5_000_000_000);
}

describe('pub/sub stall probe: overlapping ticks and stale results (#86, security C15/F20)', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  it('replaces a stalled link once when a later tick fails on the old link too', async () => {
    const t = setup();
    await t.pubsub.start();
    const sub0 = t.subs[0]!;
    const pings = sub0.hold();
    // Command timeout > probe interval: the next tick fires while the first PING is pending.
    const first = t.pubsub.probe();
    const second = t.pubsub.probe();
    pings[0]!.resolve(false);
    await first;
    await tick();
    expect(t.subs).toHaveLength(2);
    expect(t.pubsub.healthy).toBe(true);
    // The old link's later PING times out as well.
    pings[1]?.resolve(false);
    await second;
    await tick();
    expect(t.resyncs()).toBe(1);
    expect(t.lost()).toHaveLength(1);
    expect(t.lost()[0]).toMatchObject({ cause: 'stalled' });
    expect(t.subs).toHaveLength(2);
    expect(t.subs[1]!.closed).toBe(false);
    expect(t.pubsub.healthy).toBe(true);
  });

  it('skips a tick while a probe is in flight', async () => {
    const t = setup();
    await t.pubsub.start();
    const sub0 = t.subs[0]!;
    const before = sub0.pings;
    const pings = sub0.hold();
    const first = t.pubsub.probe();
    await t.pubsub.probe();
    await t.pubsub.probe();
    expect(sub0.pings - before).toBe(1);
    pings[0]!.resolve(true);
    await first;
    expect(t.resyncs()).toBe(0);
  });

  it('ignores an old PING failing after the link was replaced by another path', async () => {
    const t = setup();
    await t.pubsub.start();
    const sub0 = t.subs[0]!;
    const pings = sub0.hold();
    const pending = t.pubsub.probe();
    regress(sub0);
    expect(t.resyncs()).toBe(1);
    await tick();
    const sub1 = t.subs[1]!;
    expect(t.pubsub.healthy).toBe(true);
    // replace() cleared the in-flight flag: the next tick probes the new link.
    const before = sub1.pings;
    await t.pubsub.probe();
    expect(sub1.pings - before).toBe(1);
    pings[0]!.resolve(false);
    await pending;
    await tick();
    expect(t.resyncs()).toBe(1);
    expect(t.lost()).toHaveLength(1);
    expect(t.lost()[0]).toMatchObject({ cause: 'regressed' });
    expect(t.subs).toHaveLength(2);
    expect(sub1.closed).toBe(false);
    expect(t.pubsub.healthy).toBe(true);
  });

  it('still replaces a genuinely stalled current link, once, and probes every new link', async () => {
    const t = setup();
    await t.pubsub.start();
    t.subs[0]!.probeImpl = () => Promise.resolve(false);
    await t.pubsub.probe();
    expect(t.resyncs()).toBe(1);
    await tick();
    const sub1 = t.subs[1]!;
    expect(t.pubsub.healthy).toBe(true);
    await t.pubsub.probe();
    await t.pubsub.probe();
    expect(t.resyncs()).toBe(1);
    sub1.probeImpl = () => Promise.resolve(false);
    await t.pubsub.probe();
    expect(t.resyncs()).toBe(2);
    await tick();
    expect(sub1.closed).toBe(true);
    expect(t.subs).toHaveLength(3);
    expect(t.subs[2]!.closed).toBe(false);
    expect(t.pubsub.healthy).toBe(true);
    expect(t.lost().map((record) => record.cause)).toEqual(['stalled', 'stalled']);
  });

  it('clears the in-flight flag on success, failure and rejection; a rejection counts as failed', async () => {
    const t = setup();
    await t.pubsub.start();
    const sub0 = t.subs[0]!;
    let before = sub0.pings;
    // Success: the next tick probes again.
    await t.pubsub.probe();
    await t.pubsub.probe();
    expect(sub0.pings - before).toBe(2);
    // Rejection: a failed probe of that link (fail closed), not an unhandled rejection.
    sub0.probeImpl = () => Promise.reject(new Error('connection reset'));
    void t.pubsub.probe();
    await tick();
    expect(t.resyncs()).toBe(1);
    expect(t.lost()[0]).toMatchObject({ cause: 'stalled' });
    expect(unhandled).toEqual([]);
    const sub1 = t.subs[1]!;
    expect(t.pubsub.healthy).toBe(true);
    before = sub1.pings;
    await t.pubsub.probe();
    expect(sub1.pings - before).toBe(1);
    // Failure: replaced, and the next tick probes the new link.
    sub1.probeImpl = () => Promise.resolve(false);
    await t.pubsub.probe();
    expect(t.resyncs()).toBe(2);
    await tick();
    const sub2 = t.subs[2]!;
    before = sub2.pings;
    await t.pubsub.probe();
    expect(sub2.pings - before).toBe(1);
    expect(t.resyncs()).toBe(2);
  });

  it('does nothing when a pending PING fails after close()', async () => {
    const t = setup();
    await t.pubsub.start();
    const pings = t.subs[0]!.hold();
    const pending = t.pubsub.probe();
    await t.pubsub.close();
    pings[0]!.resolve(false);
    await pending;
    await tick();
    expect(t.resyncs()).toBe(0);
    expect(t.lost()).toHaveLength(0);
    expect(t.subs).toHaveLength(1);
  });

  it('does not let an old probe settling after a replace clear the newer probe’s flag (RC2)', async () => {
    const t = setup();
    await t.pubsub.start();
    const sub0 = t.subs[0]!;
    const old = sub0.hold();
    const stale = t.pubsub.probe();
    regress(sub0);
    await tick();
    const sub1 = t.subs[1]!;
    expect(t.pubsub.healthy).toBe(true);
    const before = sub1.pings;
    const pings = sub1.hold();
    const current = t.pubsub.probe();
    expect(sub1.pings - before).toBe(1);
    // The old link's PING settles while the new probe is in flight.
    old[0]!.resolve(false);
    await stale;
    await tick();
    // The newer probe is still in flight: this tick is skipped.
    await t.pubsub.probe();
    expect(sub1.pings - before).toBe(1);
    expect(t.resyncs()).toBe(1);
    pings[0]!.resolve(true);
    await current;
    sub1.probeImpl = () => Promise.resolve(true);
    await t.pubsub.probe();
    expect(sub1.pings - before).toBe(2);
    expect(t.resyncs()).toBe(1);
  });
});
