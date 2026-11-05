import { describe, expect, it } from 'vitest';
import { type SwipeContext, classifySwipe } from '../src/navigation/swipe.js';

const ctx: SwipeContext = { width: 400, pointers: 1, zoomed: false, selection: false };
const at = (x: number, y = 0, t = 0) => ({ x, y, t });

describe('classifySwipe (AC13, design.md section 5)', () => {
  it('right-to-left finger: next in LTR, previous in RTL', () => {
    expect(classifySwipe(at(300), at(200, 0, 200), ctx, 'ltr')).toBe('next');
    expect(classifySwipe(at(300), at(200, 0, 200), ctx, 'rtl')).toBe('previous');
  });

  it('left-to-right finger: previous in LTR, next in RTL', () => {
    expect(classifySwipe(at(100), at(200, 0, 200), ctx, 'ltr')).toBe('previous');
    expect(classifySwipe(at(100), at(200, 0, 200), ctx, 'rtl')).toBe('next');
  });

  it('needs at least 48 px', () => {
    expect(classifySwipe(at(100), at(147, 0, 100), ctx, 'ltr')).toBeNull();
    expect(classifySwipe(at(100), at(148, 0, 100), ctx, 'ltr')).toBe('previous');
  });

  it('needs |dx| > 1.5 |dy|', () => {
    expect(classifySwipe(at(100), at(190, 60, 100), ctx, 'ltr')).toBeNull();
    expect(classifySwipe(at(100), at(191, 60, 100), ctx, 'ltr')).toBe('previous');
  });

  it('a slow swipe counts only past 30 % of the width', () => {
    expect(classifySwipe(at(100), at(200, 0, 900), ctx, 'ltr')).toBeNull();
    expect(classifySwipe(at(100), at(220, 0, 900), ctx, 'ltr')).toBe('previous');
  });

  it.each<[string, Partial<SwipeContext>]>([
    ['a selection', { selection: true }],
    ['two fingers', { pointers: 2 }],
    ['a zoomed page', { zoomed: true }],
  ])('is ignored with %s', (_name, extra) => {
    expect(classifySwipe(at(300), at(100, 0, 100), { ...ctx, ...extra }, 'ltr')).toBeNull();
  });
});
