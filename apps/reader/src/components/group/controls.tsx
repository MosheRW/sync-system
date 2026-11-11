import { type ReactNode, type Ref, forwardRef, useEffect, useRef } from 'react';
import styles from './group.module.css';

export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'danger' | 'text';
  /** In flight: spinner and "…ing" label, `aria-disabled`, still focusable (design 6.1). */
  pending?: boolean;
  pendingLabel?: string;
  /** Looks and acts disabled but stays focusable and explainable (design 6.1). */
  inactive?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
  /** A submit button in the sheet footer names its form. */
  form?: string;
  className?: string;
  'aria-label'?: string;
  'aria-describedby'?: string;
  children: ReactNode;
}

/** Sheet and prompt buttons: never `disabled`, `aria-disabled` while in flight. */
export const Button = forwardRef(function Button(
  {
    variant = 'secondary',
    pending = false,
    pendingLabel,
    inactive = false,
    onClick,
    type = 'button',
    form,
    className,
    children,
    ...aria
  }: ButtonProps,
  ref: Ref<HTMLButtonElement>,
) {
  const off = pending || inactive;
  return (
    <button
      ref={ref}
      type={type}
      {...(form !== undefined ? { form } : {})}
      className={`${styles.button} ${styles[variant]} ${className ?? ''}`}
      aria-disabled={off ? 'true' : undefined}
      {...aria}
      onClick={(event) => {
        if (off) {
          event.preventDefault();
          return;
        }
        if (type === 'button') onClick?.();
      }}
    >
      {pending ? <span className={styles.spinner} aria-hidden="true" /> : null}
      {pending && pendingLabel !== undefined ? pendingLabel : children}
    </button>
  );
});

/** A back chevron pointing to the interface start (design 4.4). */
export function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={styles.backButton} onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={styles.backIcon}>
        <path
          d="M15 5l-7 7 7 7"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {label}
    </button>
  );
}

const AUTO_HIDE_TICK_MS = 250;

/**
 * Calls `onAutoHide` after `autoHideMs` of **visible** time (#25 design 2.4):
 * the clock runs only while the tab is visible, the pointer is not over the
 * bar and focus is not inside it. Monotonic (`performance.now()`), checked
 * every 250 ms and on each of those events.
 */
function useAutoHide(
  ref: { readonly current: HTMLElement | null },
  autoHideMs: number | undefined,
  onAutoHide: (() => void) | undefined,
): void {
  const callback = useRef(onAutoHide);
  callback.current = onAutoHide;
  useEffect(() => {
    const element = ref.current;
    if (autoHideMs === undefined || element === null) return undefined;
    let shownMs = 0;
    let since: number | null = null;
    let hover = false;
    let focus = false;
    let done = false;
    const running = () => document.visibilityState !== 'hidden' && !hover && !focus;
    const check = () => {
      const now = performance.now();
      if (since !== null) shownMs += now - since;
      since = running() ? now : null;
      if (!done && shownMs >= autoHideMs) {
        done = true;
        callback.current?.();
      }
    };
    const change = (apply: () => void) => {
      check();
      apply();
      check();
    };
    const onEnter = () => change(() => (hover = true));
    const onLeave = () => change(() => (hover = false));
    const onFocusIn = () => change(() => (focus = true));
    const onFocusOut = (event: FocusEvent) =>
      change(() => (focus = element.contains(event.relatedTarget as Node | null)));
    since = running() ? performance.now() : null;
    const timer = setInterval(check, AUTO_HIDE_TICK_MS);
    element.addEventListener('pointerenter', onEnter);
    element.addEventListener('pointerleave', onLeave);
    element.addEventListener('focusin', onFocusIn);
    element.addEventListener('focusout', onFocusOut);
    document.addEventListener('visibilitychange', check);
    return () => {
      clearInterval(timer);
      element.removeEventListener('pointerenter', onEnter);
      element.removeEventListener('pointerleave', onLeave);
      element.removeEventListener('focusin', onFocusIn);
      element.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('visibilitychange', check);
    };
  }, [ref, autoHideMs]);
}

/** A notice: banner slot, codes notice, overlay layer (design 4.1, #25 design 6.9). */
export function NoticeBar({
  children,
  onDismiss,
  dismissLabel,
  tone = 'info',
  autoFocus = false,
  autoHideMs,
  onAutoHide,
}: {
  children: ReactNode;
  onDismiss?: () => void;
  dismissLabel: string;
  tone?: 'info' | 'warning';
  /** Focus Dismiss on appearance (focus was in something that closed, design F12.3). */
  autoFocus?: boolean;
  /** Info notices: hide after this much visible time (#25 design 2.4); no visual timer. */
  autoHideMs?: number;
  onAutoHide?: () => void;
}) {
  const dismissRef = useRef<HTMLButtonElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) dismissRef.current?.focus();
  }, [autoFocus]);
  useAutoHide(barRef, autoHideMs, onAutoHide);
  return (
    <div
      ref={barRef}
      role="status"
      className={`${styles.notice} ${tone === 'warning' ? styles.noticeWarning : ''}`}
    >
      <p className={styles.noticeText}>{children}</p>
      {onDismiss ? (
        <button ref={dismissRef} type="button" className={styles.textButton} onClick={onDismiss}>
          {dismissLabel}
        </button>
      ) : null}
    </div>
  );
}
