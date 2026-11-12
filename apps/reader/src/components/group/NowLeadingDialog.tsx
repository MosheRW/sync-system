import { useId } from 'react';
import type { NowLeading } from '../../group/use-leadership-flow.js';
import { useI18n } from '../../i18n/index.js';
import { Button } from './controls.js';
import { Dialog } from './Dialog.js';
import styles from './group.module.css';
import { Num, Template } from './Template.js';

const REASON = {
  handoff_disconnect: 'nowLeadingDisconnect',
  handoff_inactivity: 'nowLeadingInactive',
  take_back: 'nowLeadingTakeBack',
} as const;

/**
 * "You're leading the group now" (#25 design 6.8, F22, AC46): a modal
 * `alertdialog`; focus starts on the heading so the whole message is read
 * first; Esc is Start leading (dismissing is the only choice). Focus then
 * goes back where it was, else to the article.
 */
export function NowLeadingDialog({
  state,
  onDismiss,
  returnFocus,
}: {
  state: NowLeading;
  onDismiss: () => void;
  returnFocus: () => HTMLElement | null;
}) {
  const { t, lang } = useI18n();
  const bodyId = useId();
  return (
    <Dialog
      role="alertdialog"
      title={t.nowLeadingTitle}
      onCancel={onDismiss}
      returnFocus={returnFocus}
      describedBy={bodyId}
      footer={
        <Button variant="primary" onClick={onDismiss}>
          {t.startLeading}
        </Button>
      }
    >
      <div id={bodyId} className={styles.stack}>
        <p className={styles.para}>{t[REASON[state.reason]]}</p>
        <p className={styles.para}>{t.nowLeadingWhat}</p>
        {state.offPage !== null ? (
          <p className={styles.para}>
            <Template
              text={t.nowLeadingOffPage}
              values={{
                view: <Num value={state.offPage.ownIndex + 1} lang={lang} />,
                group: <Num value={state.offPage.groupIndex + 1} lang={lang} />,
              }}
            />
          </p>
        ) : null}
        {state.mismatch ? <p className={styles.para}>{t.nowLeadingMismatch}</p> : null}
      </div>
    </Dialog>
  );
}
