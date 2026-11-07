import { useRef } from 'react';
import { useI18n } from '../../i18n/index.js';
import { Button } from './controls.js';
import { Dialog } from './Dialog.js';
import styles from './group.module.css';

export interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  pendingLabel: string;
  /** End group uses the danger style; Get new codes the primary (design 6.16). */
  tone: 'danger' | 'primary';
  pending: boolean;
  /** A failure line shown above the buttons (role="alert"). */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A confirmation (design 6.16): `role="alertdialog"`, focus starts on
 * **Cancel** (the safe choice), Esc cancels, focus returns to the opener.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  pendingLabel,
  tone,
  pending,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      role="alertdialog"
      title={title}
      onCancel={onCancel}
      initialFocus={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="secondary" onClick={onCancel}>
            {t.cancel}
          </Button>
          <Button variant={tone} pending={pending} pendingLabel={pendingLabel} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className={styles.para}>{body}</p>
      {error ? (
        <p role="alert" className={styles.formError}>
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
