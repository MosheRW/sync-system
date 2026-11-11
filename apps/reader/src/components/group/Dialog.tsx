import { type ReactNode, type RefObject, useEffect, useId, useRef } from 'react';
import styles from './group.module.css';

export interface DialogProps {
  /** `alertdialog` for confirmations and the version warning (design 6.11, 6.16). */
  role?: 'dialog' | 'alertdialog';
  /** The visible title; also the accessible name (`aria-labelledby`). */
  title: ReactNode;
  /** Called on Esc and on the close button; omit to make Esc do nothing (a choice is required). */
  onCancel?: () => void;
  /** Where focus starts; default the title. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Where focus goes after closing when the opener is gone; default the opener. */
  returnFocus?: () => HTMLElement | null;
  /** `sheet`: bottom sheet on phones, centred dialog from 640 px (design 4.4). */
  variant?: 'sheet' | 'dialog';
  /** Header start: a Back button in sheet sub-views. */
  headerStart?: ReactNode;
  /** A labelled close button in the header (sheets). */
  closeLabel?: string;
  footer?: ReactNode;
  /**
   * The sheet's current view. When it changes, focus moves to the view's
   * first field (`data-autofocus`, else the first input) or its title
   * (design 6.1).
   */
  viewKey?: string;
  children?: ReactNode;
}

/**
 * The one modal primitive (#24 D2, architecture 7.7): a native `<dialog>`
 * opened with `showModal()` (inert background, focus inside), labelled by
 * its title. Focus starts on `initialFocus` or the title and returns to the
 * element that had it before (or `returnFocus()`), never to `body`. Esc
 * calls `onCancel`; without it Esc does nothing.
 */
export function Dialog({
  role = 'dialog',
  title,
  onCancel,
  initialFocus,
  returnFocus,
  variant = 'dialog',
  headerStart,
  closeLabel,
  footer,
  viewKey,
  children,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const shownView = useRef(viewKey);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const returnRef = useRef(returnFocus);
  returnRef.current = returnFocus;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    (initialFocus?.current ?? titleRef.current)?.focus();
    // Esc fires `cancel`; the app decides what closes (never the browser alone).
    const onNativeCancel = (event: Event) => {
      event.preventDefault();
      onCancelRef.current?.();
    };
    dialog.addEventListener('cancel', onNativeCancel);
    return () => {
      dialog.removeEventListener('cancel', onNativeCancel);
      if (dialog.open) dialog.close();
      const target =
        opener !== null && opener.isConnected && opener !== document.body
          ? opener
          : (returnRef.current?.() ?? null);
      target?.focus();
    };
    // Opened once per mount; later prop changes don't reopen it.
  }, []);

  useEffect(() => {
    if (shownView.current === viewKey) return;
    shownView.current = viewKey;
    const dialog = ref.current;
    const target =
      dialog?.querySelector<HTMLElement>('[data-autofocus]') ??
      dialog?.querySelector<HTMLElement>(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
      ) ??
      titleRef.current;
    target?.focus();
  }, [viewKey]);

  return (
    <dialog
      ref={ref}
      role={role === 'alertdialog' ? 'alertdialog' : undefined}
      aria-labelledby={titleId}
      aria-modal="true"
      className={variant === 'sheet' ? styles.sheet : styles.dialog}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        // jsdom fires no `cancel`; browsers fire it after this keydown is not prevented.
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current?.();
      }}
    >
      <div className={styles.sheetHeader}>
        {headerStart ?? null}
        <h2 ref={titleRef} id={titleId} tabIndex={-1} className={styles.sheetTitle}>
          {title}
        </h2>
        {closeLabel !== undefined && onCancel !== undefined ? (
          <button
            type="button"
            className={styles.iconButton}
            aria-label={closeLabel}
            onClick={() => onCancelRef.current?.()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={styles.icon}>
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        ) : null}
      </div>
      <div className={styles.sheetBody}>{children}</div>
      {footer !== undefined ? <div className={styles.sheetFooter}>{footer}</div> : null}
    </dialog>
  );
}
