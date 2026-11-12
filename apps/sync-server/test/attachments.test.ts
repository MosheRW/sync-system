import { describe, expect, it } from 'vitest';
import {
  AttachmentRegistry,
  decodeRegistry,
  encodeRegistry,
  instancesOf,
} from '../src/storage/redis/attachments.js';

const PID = '11111111-1111-4111-8111-111111111111';
const PID2 = '22222222-2222-4222-8222-222222222222';
const I = 'ab'.repeat(16);
const T = 'A'.repeat(22);

describe('attachment registry (#35 architecture 12.6, security C1, C16)', () => {
  it('round-trips with pids sorted, and is empty-as-absent', () => {
    const map = new Map([
      [PID2, { i: I, t: T }],
      [PID, { i: I, t: 'b'.repeat(22) }],
    ]);
    const text = encodeRegistry(map)!;
    expect(text.indexOf(PID)).toBeLessThan(text.indexOf(PID2));
    expect(decodeRegistry(text)).toEqual(map);
    expect(encodeRegistry(new Map())).toBeUndefined();
  });

  it.each([
    ['not json', 'nope'],
    ['another version', JSON.stringify({ v: 2, a: {} })],
    ['an extra field', JSON.stringify({ v: 1, a: {}, x: 1 })],
    ['an extra entry field', JSON.stringify({ v: 1, a: { [PID]: { i: I, t: T, x: 1 } } })],
    ['a bad pid', JSON.stringify({ v: 1, a: { 'not-a-pid': { i: I, t: T } } })],
    ['a __proto__ key', `{"v":1,"a":{"__proto__":{"i":"${I}","t":"${T}"}}}`],
    ['a bad instance', JSON.stringify({ v: 1, a: { [PID]: { i: 'x', t: T } } })],
    ['a bad attach ID', JSON.stringify({ v: 1, a: { [PID]: { i: I, t: 'short' } } })],
  ])('rejects %s', (_case, text) => {
    expect(decodeRegistry(text)).toBe('invalid');
  });

  it('deletes an entry only while it is still the same attachment', () => {
    const registry = new AttachmentRegistry(new Map([[PID, { i: I, t: T }]]));
    registry.delete(PID, 'c'.repeat(22));
    expect(registry.get(PID)).toEqual({ i: I, t: T });
    registry.delete(PID, T);
    expect(registry.get(PID)).toBeUndefined();
    // The loaded snapshot stays as read.
    expect(registry.loaded.get(PID)).toEqual({ i: I, t: T });
    expect(instancesOf(registry.loaded)).toEqual(new Set([I]));
  });
});
