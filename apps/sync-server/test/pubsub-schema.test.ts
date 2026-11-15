import { describe, expect, it } from 'vitest';
import type { RemoteEffect } from '../src/groups/remote-effects.js';
import { PUBSUB_EFFECTS_MAX, PUBSUB_MESSAGE_MAX_BYTES } from '../src/limits/constants.js';
import { createLogger } from '../src/logging/logger.js';
import { encodeBatches, parseRemoteMessage } from '../src/storage/redis/pubsub.js';
import { LogCapture } from './helpers/log-capture.js';

const ns = 'app-a';
const gid = 'G'.repeat(43);
const pid = '11111111-1111-4111-8111-111111111111';
const att = 'A'.repeat(22);
const rid = 'R'.repeat(22);
const text = '{"type":"position.updated"}';

const VALID: RemoteEffect[] = [
  { op: 'deliver', ns, gid, pid, att, text, later: false },
  { op: 'detach', ns, gid, pid, att, reason: 'removed', text, close: 4004 },
  { op: 'detach', ns, gid, pid, att, reason: 'replaced' },
  { op: 'admit', ns, gid, pid, att, rid, text },
  { op: 'settle', ns, gid, rid, text },
  { op: 'refresh', ns, gid, pid, att, at: 1_700_000_000_000 },
  { op: 'admitParked', ns, gid },
  { op: 'forget', ns, gid },
];

function message(effects: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, s: 5, effects, ...extra });
}

describe('pub/sub message contract (#35 architecture 12.7, security P2-4, C15)', () => {
  it('accepts every effect type', () => {
    expect(parseRemoteMessage(message(VALID))).toEqual({ s: 5, effects: VALID });
  });

  it.each([
    ['another version', JSON.stringify({ v: 2, s: 5, effects: [VALID[0]] })],
    ['no sequence', JSON.stringify({ v: 1, effects: [VALID[0]] })],
    ['a negative sequence', JSON.stringify({ v: 1, s: -1, effects: [VALID[0]] })],
    ['an extra top-level field', message([VALID[0]], { x: 1 })],
    ['no effects', message([])],
    ['too many effects', message(Array.from({ length: PUBSUB_EFFECTS_MAX + 1 }, () => VALID[7]))],
    ['an unknown op', message([{ op: 'eval', ns, gid }])],
    ['an extra effect field', message([{ ...VALID[0], extra: 1 }])],
    ['a bad namespace', message([{ ...VALID[0], ns: 'App:x' }])],
    ['a bad group ID', message([{ ...VALID[0], gid: 'short' }])],
    ['a bad participant ID', message([{ ...VALID[0], pid: 'nope' }])],
    ['a bad attach ID', message([{ ...VALID[0], att: 'x' }])],
    ['a bad request ID', message([{ ...VALID[4], rid: 'x' }])],
    ['another close code', message([{ ...VALID[1], close: 1000 }])],
    ['an oversized frame', message([{ ...VALID[0], text: 'x'.repeat(131_073) }])],
    ['a frame that is too short', message([{ ...VALID[0], text: 'x' }])],
    ['not JSON', 'nope'],
  ])('rejects %s', (_case, raw) => {
    expect(parseRemoteMessage(raw)).toBe('invalid');
  });

  it('rejects a message over 1 MiB before parsing it', () => {
    const raw = message([{ ...VALID[7], pad: 'x'.repeat(PUBSUB_MESSAGE_MAX_BYTES) }]);
    expect(parseRemoteMessage(raw)).toBe('invalid');
  });

  it('splits effects into ordered messages under the limits', () => {
    const logs = new LogCapture();
    const logger = createLogger({ level: 'trace', destination: logs });
    const big = 'x'.repeat(100_000);
    const effects: RemoteEffect[] = Array.from({ length: 30 }, (_v, i) => ({
      op: 'deliver',
      ns,
      gid,
      pid,
      att,
      text: `{"n":${i},"p":"${big}"}`,
      later: false,
    }));
    const batches = encodeBatches(effects, logger);
    expect(batches.length).toBeGreaterThan(1);
    const flat = batches.flatMap((batch) => JSON.parse(batch) as RemoteEffect[]);
    expect(flat).toEqual(effects);
    for (const batch of batches) {
      const wrapped = `{"v":1,"s":1700000000000000,"effects":${batch}}`;
      expect(Buffer.byteLength(wrapped)).toBeLessThanOrEqual(PUBSUB_MESSAGE_MAX_BYTES);
      expect(parseRemoteMessage(wrapped)).not.toBe('invalid');
    }
    // A single frame over the cap is a bug: logged, not sent.
    const tooBig = encodeBatches(
      [{ op: 'deliver', ns, gid, pid, att, text: 'y'.repeat(131_073), later: false }],
      logger,
    );
    expect(tooBig).toEqual([]);
    expect(logs.find('remote_effect_too_large')).toMatchObject({ op: 'deliver' });
    expect(logs.text).not.toContain('yyyy');
  });

  it('caps a batch at the most effects per message', () => {
    const logger = createLogger({ level: 'silent' });
    const batches = encodeBatches(
      Array.from({ length: PUBSUB_EFFECTS_MAX + 3 }, () => VALID[7]!),
      logger,
    );
    expect(batches.map((batch) => (JSON.parse(batch) as unknown[]).length)).toEqual([
      PUBSUB_EFFECTS_MAX,
      3,
    ]);
  });
});
