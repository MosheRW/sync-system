import type { Direction } from '../content/schema.js';

export interface PointerPoint {
  x: number;
  y: number;
  /** Milliseconds. */
  t: number;
}

export interface SwipeContext {
  /** Width of the swipe area in CSS pixels. */
  width: number;
  /** Pointers down during the gesture (more than one is a pinch). */
  pointers: number;
  /** The page is zoomed and can pan horizontally. */
  zoomed: boolean;
  /** A text selection is active. */
  selection: boolean;
}

export const SWIPE = {
  minDistance: 48,
  ratio: 1.5,
  maxDurationMs: 600,
  minWidthFraction: 0.3,
} as const;

/**
 * Classifies a pointer gesture (design.md section 5, AC13): a horizontal
 * move of at least 48 px with |dx| > 1.5 |dy|, finished within 600 ms or
 * past 30 % of the width. Ignored with a selection, several pointers or a
 * zoomed page. A finger moving right-to-left is "next" in an LTR document
 * and "previous" in an RTL one.
 */
export function classifySwipe(
  start: PointerPoint,
  end: PointerPoint,
  context: SwipeContext,
  docDir: Direction,
): 'next' | 'previous' | null {
  if (context.pointers !== 1 || context.zoomed || context.selection) return null;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.abs(dx);
  if (distance < SWIPE.minDistance || distance <= SWIPE.ratio * Math.abs(dy)) return null;
  const quick = end.t - start.t <= SWIPE.maxDurationMs;
  const far = distance >= SWIPE.minWidthFraction * context.width;
  if (!quick && !far) return null;
  const towardLeft = dx < 0;
  if (docDir === 'rtl') return towardLeft ? 'previous' : 'next';
  return towardLeft ? 'next' : 'previous';
}
