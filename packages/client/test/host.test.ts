import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TIMER_MS,
  clampDelay,
  clearTimer,
  globalWebSocket,
  parseUrl,
  setClampedTimeout,
  textEncoder,
} from '../src/host.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('clampDelay (M1)', () => {
  it('clamps to [0, 2^31-1] and turns NaN into 0', () => {
    expect(clampDelay(500)).toBe(500);
    expect(clampDelay(-1)).toBe(0);
    expect(clampDelay(Number.NaN)).toBe(0);
    expect(clampDelay(Number.POSITIVE_INFINITY)).toBe(MAX_TIMER_MS);
    expect(clampDelay(1e12)).toBe(MAX_TIMER_MS);
  });
});

describe('setClampedTimeout', () => {
  it('passes the clamped delay to the global setTimeout, read at call time', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const fn = vi.fn();
    setClampedTimeout(fn, 1e12);
    expect(spy).toHaveBeenLastCalledWith(fn, MAX_TIMER_MS);
    setClampedTimeout(fn, Number.NaN);
    expect(spy).toHaveBeenLastCalledWith(fn, 0);
    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('clearTimer cancels the timer and accepts undefined', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const handle = setClampedTimeout(fn, 100);
    clearTimer(handle);
    clearTimer(undefined);
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('host globals', () => {
  it('reads the global WebSocket lazily', () => {
    class Fake {}
    vi.stubGlobal('WebSocket', Fake);
    expect(globalWebSocket()).toBe(Fake);
    vi.stubGlobal('WebSocket', undefined);
    expect(globalWebSocket()).toBeUndefined();
  });

  it('encodes UTF-8 and parses URLs', () => {
    expect(textEncoder().encode('é').length).toBe(2);
    expect(parseUrl('WSS://Example.com/x').hostname).toBe('example.com');
    expect(() => parseUrl('not a url')).toThrow();
  });
});
