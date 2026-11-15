import {
  GROUP_ID_PATTERN,
  JOIN_REQUEST_ID_PATTERN,
  NAMESPACE_PATTERN,
  PARTICIPANT_ID_PATTERN,
} from '@sync-system/protocol';
import { z } from 'zod';
import type { RemoteEffect } from '../../groups/remote-effects.js';
import {
  PUBSUB_BARRIER_MS,
  PUBSUB_EFFECTS_MAX,
  PUBSUB_FRAME_MAX_CHARS,
  PUBSUB_MESSAGE_MAX_BYTES,
  PUBSUB_SEQUENCE_REWIND_MAX,
} from '../../limits/constants.js';
import type { Logger } from '../../logging/logger.js';
import { ATTACH_ID_PATTERN } from './attachments.js';
import type { RedisLink, SubscriberLink } from './connect.js';
import type { RedisKeys } from './keys.js';

const ns = z.string().regex(NAMESPACE_PATTERN);
const gid = z.string().regex(GROUP_ID_PATTERN);
const pid = z.string().regex(PARTICIPANT_ID_PATTERN);
const att = z.string().regex(ATTACH_ID_PATTERN);
const rid = z.string().regex(JOIN_REQUEST_ID_PATTERN);
/** A serialized ServerMessage. */
const frame = z.string().min(2).max(PUBSUB_FRAME_MAX_CHARS);

/** One remote effect as received (#35 architecture 12.7, security P2-4, C15). */
const effect = z.discriminatedUnion('op', [
  z
    .object({ op: z.literal('deliver'), ns, gid, pid, att, text: frame, later: z.boolean() })
    .strict(),
  z
    .object({
      op: z.literal('detach'),
      ns,
      gid,
      pid,
      att,
      reason: z.enum(['replaced', 'removed', 'ended']),
      text: frame.optional(),
      close: z.literal(4004).optional(),
    })
    .strict(),
  z.object({ op: z.literal('admit'), ns, gid, pid, att, rid, text: frame }).strict(),
  z.object({ op: z.literal('settle'), ns, gid, rid, text: frame }).strict(),
  z
    .object({
      op: z.literal('refresh'),
      ns,
      gid,
      pid,
      att,
      at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z.object({ op: z.literal('admitParked'), ns, gid }).strict(),
  z.object({ op: z.literal('forget'), ns, gid }).strict(),
]);

/**
 * The only input accepted on an instance's channel (#35 architecture 12.7):
 * `v: 1`, the publishing commit's sequence `s` (Gate 2 Q-B10) and 1 to 512
 * effects. Anything else is dropped whole.
 */
export const remoteMessage = z
  .object({
    v: z.literal(1),
    s: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    effects: z.array(effect).min(1).max(PUBSUB_EFFECTS_MAX),
  })
  .strict();

export interface RemoteMessage {
  s: number;
  effects: RemoteEffect[];
}

/**
 * Parses a received message: the byte length first (no parse above 1 MiB),
 * then JSON, then the strict schema (security C15). `'invalid'` otherwise.
 */
export function parseRemoteMessage(text: string): RemoteMessage | 'invalid' {
  if (Buffer.byteLength(text, 'utf8') > PUBSUB_MESSAGE_MAX_BYTES) return 'invalid';
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 'invalid';
  }
  const parsed = remoteMessage.safeParse(value);
  if (!parsed.success) return 'invalid';
  return { s: parsed.data.s, effects: parsed.data.effects };
}

/** Room left in a message for the envelope `{"v":1,"s":<16 digits>,"effects":...}`. */
const ENVELOPE_BYTES = 64;

/**
 * The effects for one instance as JSON array texts, in order, each under
 * the message limits (#35 architecture 12.7). An effect whose frame is over
 * the frame cap is a bug: logged (no content) and not sent.
 */
export function encodeBatches(effects: readonly RemoteEffect[], logger: Logger): string[] {
  const budget = PUBSUB_MESSAGE_MAX_BYTES - ENVELOPE_BYTES;
  const out: string[] = [];
  let batch: string[] = [];
  let bytes = 2;
  const flush = () => {
    if (batch.length > 0) out.push(`[${batch.join(',')}]`);
    batch = [];
    bytes = 2;
  };
  for (const item of effects) {
    const text = 'text' in item ? item.text : undefined;
    if (text !== undefined && text.length > PUBSUB_FRAME_MAX_CHARS) {
      logger.error({ event: 'remote_effect_too_large', op: item.op }, 'remote frame too large');
      continue;
    }
    const encoded = JSON.stringify(item);
    const size = Buffer.byteLength(encoded, 'utf8') + 1;
    if (batch.length > 0 && (bytes + size > budget || batch.length >= PUBSUB_EFFECTS_MAX)) flush();
    batch.push(encoded);
    bytes += size;
  }
  flush();
  return out;
}

/** Where received effects go (the group service). */
export interface RemoteReceiver {
  /** Effects received in order; applied per group through its local queue. */
  receive(effects: RemoteEffect[]): void;
}

export interface PubSubOptions {
  link: RedisLink;
  keys: RedisKeys;
  logger: Logger;
  /** The current instance ID. */
  instanceId(): string;
  /** The synchronous instance guard (security C11): no effect applies while fenced. */
  fenced(): boolean;
  /**
   * Effects may have been lost (the link dropped, stalled or lagged):
   * every local session in a group, parked or pending closes with 1001
   * (ADR 0012 at-most-once rule).
   */
  resync(): void;
  /** How long a task waits for earlier effects (default PUBSUB_BARRIER_MS). */
  barrierMs?: number;
}

/**
 * This instance's channel (#35 architecture 12.7, security P2-4, C15): a
 * subscriber link subscribed to `P:ch:<id>` only. Messages arrive in the
 * order Redis ran the commits that published them; each carries the
 * commit's sequence, which only grows. A task waits until every message
 * up to its group's high-water mark arrived (Gate 2 Q-B10). A dropped,
 * stalled (failed probe) or lagging link resyncs: sessions close with 1001
 * and the link starts again from the current sequence.
 */
export class RedisPubSub {
  private sub: SubscriberLink | undefined;
  private channel: string | undefined;
  /** The highest sequence received (or skipped by a resync). */
  private received = 0;
  private down = false;
  private replacing = false;
  private closed = false;
  private waiters: Array<{ seq: number; resolve: () => void }> = [];
  private receiver: RemoteReceiver | undefined;

  constructor(private readonly options: PubSubOptions) {}

  /** Where received effects go (set once the group service exists). */
  setReceiver(receiver: RemoteReceiver): void {
    this.receiver = receiver;
  }

  /** False while the subscriber link is down or being replaced. */
  get healthy(): boolean {
    return !this.down && !this.replacing && this.sub !== undefined;
  }

  /** Opens the subscriber link and subscribes to this instance's channel. */
  async start(): Promise<void> {
    const { link } = this.options;
    if (link.openSubscriber === undefined) return;
    const sub = await link.openSubscriber();
    sub.onState((state) => this.onLinkState(sub, state));
    this.sub = sub;
    await this.subscribe(this.options.instanceId());
  }

  /** After a self-fence: the old channel is left (best effort). */
  async leave(): Promise<void> {
    const { sub, channel } = this;
    this.channel = undefined;
    if (sub === undefined || channel === undefined) return;
    await sub.unsubscribe(channel).catch(() => undefined);
  }

  /** Registered under a new ID: subscribe to its channel. */
  async rejoin(id: string): Promise<void> {
    await this.leave();
    if (this.sub === undefined) {
      await this.reopen();
      return;
    }
    await this.subscribe(id).catch(() => this.replace('subscribe_failed'));
  }

  private async subscribe(id: string): Promise<void> {
    const channel = this.options.keys.channel(id);
    await this.sub!.subscribe(channel, (message) => this.onMessage(message));
    this.channel = channel;
    await this.baseline();
  }

  /**
   * Everything published before now is behind us (it was received, or it
   * was lost and the sessions it was for were closed). The counter is set
   * to the current sequence, lower or not (security S1): a sequence that
   * went back (`P:seq` lost, Redis time behind) or a forged high `s` must
   * not make every later message look stale.
   */
  private async baseline(): Promise<void> {
    const raw = await this.options.link.send(['GET', this.options.keys.sequence()]);
    const seq = typeof raw === 'string' && /^[0-9]{1,16}$/.test(raw) ? Number(raw) : 0;
    this.settle(seq);
  }

  private advance(seq: number): void {
    if (seq > this.received) this.settle(seq);
  }

  /** `seq` is the last sequence received: waiters up to it go on. */
  private settle(seq: number): void {
    this.received = seq;
    const ready = this.waiters.filter((waiter) => waiter.seq <= seq);
    this.waiters = this.waiters.filter((waiter) => waiter.seq > seq);
    for (const waiter of ready) waiter.resolve();
  }

  private onMessage(text: string): void {
    const parsed = parseRemoteMessage(text);
    if (parsed === 'invalid') {
      this.options.logger.warn({ event: 'pubsub_message_invalid' }, 'pub/sub message dropped');
      return;
    }
    // Commits only move forward: an older sequence is stale (Q-B10).
    if (parsed.s < this.received) {
      // Far older: the sequence went back, not one late message. Effects
      // would be dropped from now on: resync and start again (security S1).
      if (this.received - parsed.s >= PUBSUB_SEQUENCE_REWIND_MAX) {
        this.replace('regressed');
        return;
      }
      this.options.logger.debug({ event: 'pubsub_message_stale' }, 'stale pub/sub message');
      return;
    }
    this.advance(parsed.s);
    // Security C11: a fenced instance applies nothing.
    if (this.options.fenced()) return;
    this.receiver?.receive(parsed.effects);
  }

  /**
   * Resolves once every message up to `seq` arrived (#35 Gate 2 Q-B10). A
   * link that lags past the bound is treated as stalled: resync.
   */
  awaitReceived(seq: number): Promise<void> {
    if (seq <= this.received || !this.healthy) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = { seq, resolve };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        if (!this.waiters.includes(waiter)) return;
        this.waiters = this.waiters.filter((w) => w !== waiter);
        this.options.logger.warn({ event: 'pubsub_barrier_timeout' }, 'pub/sub lagging');
        this.replace('lagging');
        resolve();
      }, this.options.barrierMs ?? PUBSUB_BARRIER_MS);
      timer.unref();
    });
  }

  /** One stall probe (security C15, F20): a failed PING replaces the link. */
  async probe(): Promise<void> {
    if (this.closed || this.replacing) return;
    if (this.sub === undefined) {
      await this.reopen();
      return;
    }
    if (this.down) return;
    if (!(await this.sub.probe())) this.replace('stalled');
  }

  private onLinkState(sub: SubscriberLink, state: 'down' | 'up'): void {
    if (sub !== this.sub || this.closed) return;
    if (state === 'down') {
      if (this.down) return;
      this.down = true;
      this.release();
      this.resync('dropped');
      return;
    }
    if (!this.down) return;
    // Back: anything published meanwhile may be lost.
    this.down = false;
    this.resync('dropped');
    void this.baseline().catch(() => this.replace('baseline_failed'));
  }

  /** Drops the link and opens a new one (stalled or lagging); sessions resync. */
  private replace(cause: string): void {
    if (this.replacing || this.closed) return;
    this.replacing = true;
    const old = this.sub;
    this.sub = undefined;
    this.channel = undefined;
    this.release();
    this.resync(cause);
    void old?.close();
    void this.reopen().finally(() => {
      this.replacing = false;
    });
  }

  private async reopen(): Promise<void> {
    if (this.closed) return;
    try {
      const { link } = this.options;
      if (link.openSubscriber === undefined) return;
      const sub = await link.openSubscriber();
      if (this.closed) {
        await sub.close();
        return;
      }
      sub.onState((state) => this.onLinkState(sub, state));
      this.sub = sub;
      this.down = false;
      await this.subscribe(this.options.instanceId());
    } catch {
      // The next probe tries again.
      const sub = this.sub;
      this.sub = undefined;
      await sub?.close();
    }
  }

  /** Waiting tasks go on (their sessions are being closed). */
  private release(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  private resync(cause: string): void {
    this.options.logger.warn({ event: 'pubsub_link_lost', cause }, 'pub/sub link lost');
    this.options.resync();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.release();
    const sub = this.sub;
    this.sub = undefined;
    await sub?.close();
  }
}
