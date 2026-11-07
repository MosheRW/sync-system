import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { Direction } from '../content/schema.js';
import { type NavAction, type ScrollState, mapKey } from './input-map.js';
import { type PointerPoint, classifySwipe } from './swipe.js';

export type MoveKind = 'next' | 'previous' | 'jump';

/** Who moved the page: the reader's own turn, or the app (a group move, #24 7.2). */
export type MoveSource = 'user' | 'app';

export interface PageNavigation {
  /** Zero-based; starts at `initialIndex` (a restored page, #24 AC36). */
  index: number;
  /** The last move, for the slide animation; `null` on first render. */
  lastMove: MoveKind | null;
  /** A refused move at either end, for the rubber-band nudge; bumps on each attempt. */
  endNudge: { side: 'start' | 'end'; count: number } | null;
  /** Go to a page (clamped), by default as an app move (group following, #24). */
  goTo: (index: number, source?: MoveSource) => void;
  next: () => void;
  previous: () => void;
  perform: (action: NavAction) => void;
}

export interface PageNavigationOptions {
  /** The first page shown (clamped); default 0. */
  initialIndex?: number;
  /** Called after every page change with who caused it. */
  onMove?: (index: number, source: MoveSource) => void;
  /** Change it when the swipe area's element is replaced, to re-attach the listeners. */
  swipeKey?: unknown;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select')) return true;
  return target.closest('[contenteditable=""], [contenteditable="true"]') !== null;
}

/** Page-turn keys never act while a modal dialog is open or inside one (#24 7.7). */
function inModal(target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest('dialog')) return true;
  return document.querySelector('dialog[open]') !== null;
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
  options: PageNavigationOptions = {},
): PageNavigation {
  const clamp = (target: number) => Math.min(Math.max(target, 0), pageCount - 1);
  const [index, setIndex] = useState(() => clamp(options.initialIndex ?? 0));
  const [lastMove, setLastMove] = useState<MoveKind | null>(null);
  const [endNudge, setEndNudge] = useState<PageNavigation['endNudge']>(null);
  const indexRef = useRef(index);
  indexRef.current = index;
  const onMoveRef = useRef(options.onMove);
  onMoveRef.current = options.onMove;

  const move = useCallback(
    (target: number, kind: MoveKind, source: MoveSource) => {
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
      onMoveRef.current?.(clamped, source);
    },
    [pageCount],
  );

  const goTo = useCallback(
    (target: number, source: MoveSource = 'app') => {
      const clamped = Math.min(Math.max(target, 0), pageCount - 1);
      // Slide in the direction of travel, as for a normal turn (design F7.3);
      // a jump to the current page does nothing (no nudge).
      const kind: MoveKind =
        clamped > indexRef.current ? 'next' : clamped < indexRef.current ? 'previous' : 'jump';
      move(clamped, kind, source);
    },
    [move, pageCount],
  );
  const next = useCallback(() => move(indexRef.current + 1, 'next', 'user'), [move]);
  const previous = useCallback(() => move(indexRef.current - 1, 'previous', 'user'), [move]);
  const perform = useCallback(
    (action: NavAction) => {
      if (action === 'next') next();
      else if (action === 'previous') previous();
      else if (action === 'first') move(0, 'previous', 'user');
      else move(pageCount - 1, 'next', 'user');
    },
    [move, next, previous, pageCount],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (inModal(event.target)) return;
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
  }, [docDir, perform, swipeArea, options.swipeKey]);

  return { index, lastMove, endNudge, goTo, next, previous, perform };
}
