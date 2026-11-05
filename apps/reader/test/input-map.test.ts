import { describe, expect, it } from 'vitest';
import { type KeyInput, buttonSides, mapKey } from '../src/navigation/input-map.js';

const key = (k: string, extra: Partial<KeyInput> = {}): KeyInput => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  inEditable: false,
  ...extra,
});

const BOTTOM = { atTop: false, atBottom: true };
const TOP = { atTop: true, atBottom: false };
const MIDDLE = { atTop: false, atBottom: false };
const SHORT = { atTop: true, atBottom: true };

describe('mapKey: design.md section 5 table (AC13)', () => {
  it.each([
    // input, LTR, RTL
    ['ArrowRight', {}, SHORT, 'next', 'previous'],
    ['ArrowLeft', {}, SHORT, 'previous', 'next'],
    ['PageDown', {}, BOTTOM, 'next', 'next'],
    [' ', {}, BOTTOM, 'next', 'next'],
    ['PageUp', {}, TOP, 'previous', 'previous'],
    [' ', { shiftKey: true }, TOP, 'previous', 'previous'],
    ['Home', {}, MIDDLE, 'first', 'first'],
    ['End', {}, MIDDLE, 'last', 'last'],
  ] as const)('%s %j -> LTR %s, RTL %s', (k, extra, scroll, ltr, rtl) => {
    expect(mapKey(key(k, extra), 'ltr', scroll)).toBe(ltr);
    expect(mapKey(key(k, extra), 'rtl', scroll)).toBe(rtl);
  });

  it('lets Space/PageDown scroll a long page first', () => {
    expect(mapKey(key(' '), 'ltr', MIDDLE)).toBeNull();
    expect(mapKey(key('PageDown'), 'rtl', TOP)).toBeNull();
    expect(mapKey(key('PageUp'), 'ltr', BOTTOM)).toBeNull();
    expect(mapKey(key(' ', { shiftKey: true }), 'ltr', MIDDLE)).toBeNull();
  });

  it('always turns the page with the arrows, even mid-scroll', () => {
    expect(mapKey(key('ArrowRight'), 'ltr', MIDDLE)).toBe('next');
  });

  it('ignores Shift+Arrow (text selection)', () => {
    expect(mapKey(key('ArrowRight', { shiftKey: true }), 'ltr', SHORT)).toBeNull();
    expect(mapKey(key('ArrowLeft', { shiftKey: true }), 'rtl', SHORT)).toBeNull();
  });

  it.each(['ctrlKey', 'altKey', 'metaKey'] as const)('ignores keys with %s', (modifier) => {
    expect(mapKey(key('ArrowRight', { [modifier]: true }), 'ltr', SHORT)).toBeNull();
    expect(mapKey(key(' ', { [modifier]: true }), 'ltr', SHORT)).toBeNull();
  });

  it('ignores keys while focus is in an input', () => {
    expect(mapKey(key('ArrowRight', { inEditable: true }), 'ltr', SHORT)).toBeNull();
    expect(mapKey(key(' ', { inEditable: true }), 'ltr', SHORT)).toBeNull();
  });

  it('ignores other keys', () => {
    expect(mapKey(key('a'), 'ltr', SHORT)).toBeNull();
    expect(mapKey(key('ArrowDown'), 'ltr', SHORT)).toBeNull();
  });
});

describe('buttonSides', () => {
  it('puts next on the document end side', () => {
    expect(buttonSides('ltr')).toEqual({ left: 'previous', right: 'next' });
    expect(buttonSides('rtl')).toEqual({ left: 'next', right: 'previous' });
  });
});
