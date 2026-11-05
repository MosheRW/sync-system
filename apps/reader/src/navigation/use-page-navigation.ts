import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { Direction } from '../content/schema.js';
import { type NavAction, type ScrollState, mapKey } from './input-map.js';
import { type PointerPoint, classifySwipe } from './swipe.js';

export type MoveKind = 'next' | 'previous' | 'jump';

export interface PageNavigation {
  /** Zero-based; starts at 0 and is never stored (AC35). */
  index: number;
  /** The last move, for the slide animation; `null` on first render. */
  lastMove: MoveKind | null;
  /** A refused move at either end, for the rubber-band nudge; bumps on each attempt. */
  endNudge: { side: 'start' | 'end'; count: number } | null;
  /** Go to a page (clamped). Exposed for item 8 (design.md section 11). */
  goTo: (index: number) => void;
  next: () => void;
  previous: () => void;
  perform: (action: NavAction) => void;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select')) return true;
  return target.closest('[contenteditable=""], [contenteditable="true"]') !== null;
}

function scrollState(): ScrollState {
  const el = document.scrollingElement ?? document.documentElement;
  return {
    atTop: el.scrollTop <= 1,
    atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
  };
}

function hasSelection(): boolean {
  const selection = document.getSelection();
  return selection !== null && !selection.isCollapsed;
}

function isZoomed(): boolean {
  return (window.visualViewport?.scale ?? 1) > 1.01;
}

/**
 * Page state and inputs for the reading screen (AC13, AC35): keys on the
 * document, swipes on the content region, buttons through `next`/
 * `previous`. The mapping follows the document direction only.
 */
export function usePageNavigation(
  pageCount: number,
  docDir: Direction,
  swipeArea: RefObject<HTMLElement | null>,
): PageNavigation {
  const [index, setIndex] = useState(0);
  const [lastMove, setLastMove] = useState<MoveKind | null>(null);
  const [endNudge, setEndNudge] = useState<PageNavigation['endNudge']>(null);
  const indexRef = useRef(0);
  indexRef.current = index;

  const move = useCallback(
    (target: number, kind: MoveKind) => {
      const clamped = Math.min(Math.max(target, 0), pageCount - 1);
      if (clamped === indexRef.current) {
        if (kind !== 'jump') {
          setEndNudge((prev) => ({
            side: kind === 'next' ? 'end' : 'start',
            count: (prev?.count ?? 0) + 1,
          }));
        }
        return;
      }
      indexRef.current = clamped;
      setIndex(clamped);
      setLastMove(kind);
      const el = document.scrollingElement ?? document.documentElement;
      el.scrollTop = 0;
    },
    [pageCount],
  );

  const goTo = useCallback((target: number) => move(target, 'jump'), [move]);
  const next = useCallback(() => move(indexRef.current + 1, 'next'), [move]);
  const previous = useCallback(() => move(indexRef.current - 1, 'previous'), [move]);
  const perform = useCallback(
    (action: NavAction) => {
      if (action === 'next') next();
      else if (action === 'previous') previous();
      else if (action === 'first') move(0, 'previous');
      else move(pageCount - 1, 'next');
    },
    [move, next, previous, pageCount],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = mapKey(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          inEditable: isEditable(event.target),
        },
        docDir,
        scrollState(),
      );
      if (!action) return;
      event.preventDefault();
      perform(action);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [docDir, perform]);

  useEffect(() => {
    const area = swipeArea.current;
    if (!area) return;
    const down = new Map<number, PointerPoint>();
    let start: PointerPoint | null = null;
    let maxPointers = 0;

    const onDown = (event: PointerEvent) => {
      if (event.pointerType === 'mouse') return;
      down.set(event.pointerId, { x: event.clientX, y: event.clientY, t: event.timeStamp });
      if (down.size === 1) {
        start = { x: event.clientX, y: event.clientY, t: event.timeStamp };
        maxPointers = 1;
      } else {
        maxPointers = Math.max(maxPointers, down.size);
      }
    };
    const onUp = (event: PointerEvent) => {
      if (!down.has(event.pointerId)) return;
      down.delete(event.pointerId);
      if (down.size > 0 || !start) return;
      const action = classifySwipe(
        start,
        { x: event.clientX, y: event.clientY, t: event.timeStamp },
        {
          width: area.clientWidth || window.innerWidth,
          pointers: maxPointers,
          zoomed: isZoomed(),
          selection: hasSelection(),
        },
        docDir,
      );
      start = null;
      if (action) perform(action);
    };
    const onCancel = (event: PointerEvent) => {
      down.delete(event.pointerId);
      if (down.size === 0) start = null;
    };

    area.addEventListener('pointerdown', onDown);
    area.addEventListener('pointerup', onUp);
    area.addEventListener('pointercancel', onCancel);
    return () => {
      area.removeEventListener('pointerdown', onDown);
      area.removeEventListener('pointerup', onUp);
      area.removeEventListener('pointercancel', onCancel);
    };
  }, [docDir, perform, swipeArea]);

  return { index, lastMove, endNudge, goTo, next, previous, perform };
}
