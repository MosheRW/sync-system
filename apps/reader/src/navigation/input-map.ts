import type { Direction } from '../content/schema.js';

export type NavAction = 'next' | 'previous' | 'first' | 'last';

/** The parts of a `KeyboardEvent` the mapping needs (pure, testable). */
export interface KeyInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** Focus is in a text input, textarea, select or contenteditable element. */
  inEditable: boolean;
}

export interface ScrollState {
  atTop: boolean;
  atBottom: boolean;
}

/**
 * Keyboard mapping (design.md section 5, AC13). Decided by the **document**
 * direction only: ArrowRight is "next" in an LTR document and "previous" in
 * an RTL one. Only Shift may be held (and Shift+Arrow is text selection, so
 * it is ignored). Space/PageDown turn the page only when the page is
 * scrolled to the bottom, PageUp/Shift+Space only at the top; otherwise the
 * browser scrolls. Returns `null` when the key is not a page turn.
 */
export function mapKey(input: KeyInput, docDir: Direction, scroll: ScrollState): NavAction | null {
  if (input.ctrlKey || input.altKey || input.metaKey || input.inEditable) return null;
  switch (input.key) {
    case 'ArrowRight':
      if (input.shiftKey) return null;
      return docDir === 'rtl' ? 'previous' : 'next';
    case 'ArrowLeft':
      if (input.shiftKey) return null;
      return docDir === 'rtl' ? 'next' : 'previous';
    case ' ':
    case 'Spacebar':
      if (input.shiftKey) return scroll.atTop ? 'previous' : null;
      return scroll.atBottom ? 'next' : null;
    case 'PageDown':
      return scroll.atBottom ? 'next' : null;
    case 'PageUp':
      return scroll.atTop ? 'previous' : null;
    case 'Home':
      return input.shiftKey ? null : 'first';
    case 'End':
      return input.shiftKey ? null : 'last';
    default:
      return null;
  }
}

/**
 * Which action each physical side's button performs: "next" lives on the
 * document's end side (right in LTR, left in RTL), design.md section 5.
 */
export function buttonSides(docDir: Direction): { left: NavAction; right: NavAction } {
  return docDir === 'rtl'
    ? { left: 'next', right: 'previous' }
    : { left: 'previous', right: 'next' };
}
