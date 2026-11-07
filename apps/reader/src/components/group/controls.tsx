import { type ReactNode, type Ref, forwardRef } from 'react';
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

/** A docked card in the reading screen's overlay layer (design 4.1). */
export function NoticeBar({
  children,
  onDismiss,
  dismissLabel,
  tone = 'info',
}: {
  children: ReactNode;
  onDismiss?: () => void;
  dismissLabel: string;
  tone?: 'info' | 'warning';
}) {
  return (
    <div
      role="status"
      className={`${styles.notice} ${tone === 'warning' ? styles.noticeWarning : ''}`}
    >
      <p className={styles.noticeText}>{children}</p>
      {onDismiss ? (
        <button type="button" className={styles.textButton} onClick={onDismiss}>
          {dismissLabel}
        </button>
      ) : null}
    </div>
  );
}
