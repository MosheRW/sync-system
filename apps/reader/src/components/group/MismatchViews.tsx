import { useRef } from 'react';
import type { CompareResult } from '../../content/compare.js';
import { SUPPORTED_SCHEMA } from '../../content/limits.js';
import { parseLeaderMetadata } from '../../content/metadata.js';
import { useI18n } from '../../i18n/index.js';
import { PlainText } from '../PlainText.js';
import { StatusScreen } from '../StatusScreen.js';
import { Button } from './controls.js';
import { Dialog } from './Dialog.js';
import styles from './group.module.css';

/** Leader content IDs on these screens: plain text, LTR, isolated, 40 characters (AC24). */
const ID_MAX = 40;

function supported(): string {
  return SUPPORTED_SCHEMA.min === SUPPORTED_SCHEMA.max
    ? String(SUPPORTED_SCHEMA.min)
    : `${SUPPORTED_SCHEMA.min}-${SUPPORTED_SCHEMA.max}`;
}

/**
 * The block screen for `different-content` and `unsupported-schema` (design
 * 6.11, AC22, AC24): the status layout inside the reading screen's main
 * region; the member stays in the group but follows nothing. The leader's
 * metadata is read only through `parseLeaderMetadata` (C4, R6).
 */
export function MismatchBlock({
  result,
  leaderMetadata,
  canOpen,
  leavePending,
  onLeave,
  onOpen,
}: {
  result: Extract<CompareResult, 'different-content' | 'unsupported-schema'>;
  leaderMetadata: unknown;
  /** The group's book is bundled and the app isn't single-book (U2). */
  canOpen: boolean;
  leavePending: boolean;
  onLeave: () => void;
  onOpen: () => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const theirs = parseLeaderMetadata(leaderMetadata);
  const leave = { label: leavePending ? t.leaving : t.leaveGroup, onClick: onLeave, primary: true };

  if (result === 'different-content') {
    return (
      <StatusScreen
        embedded
        view={{
          heading: t.mismatchContentTitle,
          body: canOpen ? t.mismatchContentBody : t.mismatchContentBodyNoOpen,
          tone: 'neutral',
          retry: false,
          libraryLink: null,
          ...(theirs !== null
            ? {
                details: (
                  <>
                    {t.groupBookIdLabel}{' '}
                    <PlainText text={theirs.contentId} dir="ltr" maxLength={ID_MAX} />
                  </>
                ),
              }
            : {}),
        }}
        actions={canOpen ? [leave, { label: t.openGroupBook, onClick: onOpen }] : [leave]}
      />
    );
  }
  return (
    <StatusScreen
      embedded
      view={{
        heading: t.mismatchSchemaTitle,
        body: t.mismatchSchemaBody,
        tone: 'neutral',
        retry: false,
        libraryLink: null,
        details:
          theirs !== null
            ? i18n.format(t.mismatchSchemaDetails, {
                version: theirs.schemaVersion,
                supported: supported(),
              })
            : t.mismatchMalformedDetails,
      }}
      actions={[leave]}
    />
  );
}

/**
 * "Your copy is a different version" (design 6.11, AC23): a modal
 * alertdialog that needs a choice (Esc does nothing); focus on the heading.
 */
export function VersionWarnDialog({
  leavePending,
  onFollow,
  onLeave,
}: {
  leavePending: boolean;
  onFollow: () => void;
  onLeave: () => void;
}) {
  const { t } = useI18n();
  const followRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      role="alertdialog"
      title={t.mismatchVersionTitle}
      footer={
        <>
          <Button pending={leavePending} pendingLabel={t.leaving} onClick={onLeave}>
            {t.leaveGroup}
          </Button>
          <Button ref={followRef} variant="primary" onClick={onFollow}>
            {t.followAnyway}
          </Button>
        </>
      }
    >
      <p className={styles.para}>{t.mismatchVersionBody}</p>
    </Dialog>
  );
}
