import type { ReactNode } from 'react';
import { useI18n } from '../../i18n/index.js';
import { BackButton, Button } from './controls.js';
import { Dialog } from './Dialog.js';
import styles from './group.module.css';

/** One view of the Group sheet: its title, optional Back, body and footer (design 4.4). */
export interface SheetContent {
  readonly key: string;
  readonly title: ReactNode;
  readonly onBack?: () => void;
  readonly body: ReactNode;
  readonly footer?: ReactNode;
  /** `alertdialog` for views that need an answer. */
  readonly role?: 'dialog' | 'alertdialog';
}

/**
 * The modal Group sheet: a bottom sheet on phones, a centred dialog from
 * 640 px (design 4.4). One `<dialog>` stays open while its view changes;
 * focus moves to each view's first field or title. Close and Esc call
 * `onClose`; focus then returns to the opener or `returnFocus()`.
 */
export function GroupSheet({
  content,
  onClose,
  returnFocus,
}: {
  content: SheetContent;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      variant="sheet"
      role={content.role ?? 'dialog'}
      title={content.title}
      onCancel={onClose}
      closeLabel={t.close}
      viewKey={content.key}
      headerStart={
        content.onBack !== undefined ? <BackButton label={t.back} onClick={content.onBack} /> : null
      }
      {...(content.footer !== undefined ? { footer: content.footer } : {})}
      {...(returnFocus !== undefined ? { returnFocus } : {})}
    >
      {content.body}
    </Dialog>
  );
}

/** "Read together": Start a group (reading pages) or Join a group (design 6.2). */
export function startView({
  canStart,
  onStart,
  onJoin,
  t,
}: {
  canStart: boolean;
  onStart: () => void;
  onJoin: () => void;
  t: ReturnType<typeof useI18n>['t'];
}): SheetContent {
  return {
    key: 'start',
    title: t.startTitle,
    body: (
      <div className={styles.stack}>
        <p className={styles.para}>{t.startIntro}</p>
        {canStart ? (
          <Button variant="primary" className={styles.full} onClick={onStart}>
            {t.startGroup}
          </Button>
        ) : null}
        <Button className={styles.full} onClick={onJoin}>
          {t.joinGroup}
        </Button>
      </div>
    ),
  };
}
