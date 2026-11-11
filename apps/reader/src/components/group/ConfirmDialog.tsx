import { type ReactNode, useRef } from 'react';
import { useI18n } from '../../i18n/index.js';
import { Button } from './controls.js';
import { Dialog } from './Dialog.js';
import styles from './group.module.css';

export interface ConfirmDialogProps {
  /** A node, so a name in it can be `PlainText` (#25 D5). */
  title: ReactNode;
  /** A line under the title, e.g. the row's details in the remove confirmation (#25 L4). */
  detail?: ReactNode;
  body: string;
  confirmLabel: string;
  /** Default "Cancel". */
  cancelLabel?: string;
  pendingLabel: string;
  /** End group uses the danger style; Get new codes the primary (design 6.16). */
  tone: 'danger' | 'primary';
  pending: boolean;
  /** A failure line shown above the buttons (role="alert"); a node renders its own line. */
  error?: ReactNode;
  /** The confirm button looks and acts disabled (a rate-limit wait, #25 design 7.11). */
  confirmInactive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A confirmation (design 6.16): `role="alertdialog"`, focus starts on
 * **Cancel** (the safe choice), Esc cancels, focus returns to the opener.
 */
export function ConfirmDialog({
  title,
  detail,
  body,
  confirmLabel,
  cancelLabel,
  pendingLabel,
  tone,
  pending,
  error = null,
  confirmInactive = false,
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
          <Button ref={cancelRef} variant="secondary" inactive={pending} onClick={onCancel}>
            {cancelLabel ?? t.cancel}
          </Button>
          <Button
            variant={tone}
            pending={pending}
            pendingLabel={pendingLabel}
            inactive={confirmInactive}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {detail !== undefined ? <p className={styles.muted}>{detail}</p> : null}
      <p className={styles.para}>{body}</p>
      {typeof error === 'string' ? (
        <p role="alert" className={styles.formError}>
          {error}
        </p>
      ) : (
        error
      )}
    </Dialog>
  );
}
