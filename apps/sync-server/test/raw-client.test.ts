import { describe, expect, it } from 'vitest';
import { Opcode, decodeFrames, encodeFrame } from './helpers/raw-client.js';

describe('raw client frame helpers', () => {
  it('round-trips unmasked frames of every length class', () => {
    for (const size of [0, 5, 125, 126, 1000, 65535, 65536, 70000]) {
      const payload = Buffer.alloc(size, 0x61);
      const encoded = encodeFrame({ opcode: Opcode.TEXT, payload, mask: false });
      const { frames, rest } = decodeFrames(encoded);
      expect(rest.length).toBe(0);
      expect(frames).toHaveLength(1);
      expect(frames[0]!.payload.equals(payload)).toBe(true);
    }
  });

  it('masks client frames by default', () => {
    const payload = Buffer.from('hello');
    const encoded = encodeFrame({ opcode: Opcode.TEXT, payload });
    expect(encoded[1]! & 0x80).toBe(0x80);
    const { frames } = decodeFrames(encoded);
    expect(frames[0]!.payload.toString()).toBe('hello');
  });

  it('sets RSV1 and a declared length when asked', () => {
    const encoded = encodeFrame({
      opcode: Opcode.TEXT,
      payload: Buffer.alloc(0),
      rsv1: true,
      declaredLength: 1_000_000,
      mask: false,
    });
    expect(encoded[0]! & 0x40).toBe(0x40);
    expect(encoded[1]! & 0x7f).toBe(127);
    expect(Number(encoded.readBigUInt64BE(2))).toBe(1_000_000);
  });

  it('keeps an incomplete frame as the rest', () => {
    const encoded = encodeFrame({ opcode: Opcode.TEXT, payload: Buffer.alloc(300), mask: false });
    const { frames, rest } = decodeFrames(encoded.subarray(0, 100));
    expect(frames).toHaveLength(0);
    expect(rest.length).toBe(100);
  });
});
