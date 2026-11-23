import {
  type JoinedGroup,
  useConnection,
  useGroupExit,
  useSyncSnapshot,
} from '@mosherw/sync-system-react';
import { useCallback, useRef, useState } from 'react';
import { Button, NoticeBar } from '../components/group/controls.js';
import { GroupSheet, type SheetContent } from '../components/group/GroupSheet.js';
import {
  DOOR_FORM_ID,
  DoorForm,
  JOIN_FORM_ID,
  JoinErrorMessage,
  JoinForm,
  WaitingBody,
  useWaitLeft,
} from '../components/group/JoinViews.js';
import styles from '../components/group/group.module.css';
import { LibraryScreen, bookHref } from '../components/LibraryScreen.js';
import { PlainText } from '../components/PlainText.js';
import { parseLeaderMetadata } from '../content/metadata.js';
import { useI18n } from '../i18n/index.js';
import type { LibraryEntry } from '../library/types.js';
import { browserNavigation } from './browser.js';
import { type GroupEnv, useGroupEnv } from './context.js';
import { usePastedLinkNotice } from './pasted-link.js';
import { useJoin } from './use-join.js';
import { useResume } from './use-resume.js';

type View = 'join' | 'waiting' | 'opening' | 'missing';

/**
 * The library with groups (#24 design F4, 6.10): **Join a group** opens the
 * join view directly (starting needs a book). After admission the group's
 * book opens when it is bundled (a real navigation that keeps the
 * membership through the stored token, Decision Q4, architecture 8.3);
 * otherwise "This app doesn't have the group's book" with Leave group.
 */
export function GroupLibrary({ entries }: { entries: readonly LibraryEntry[] }) {
  const env = useGroupEnv();
  if (env === null || env.groupsDisabled) return <LibraryScreen entries={entries} />;
  return <GroupLibraryOn entries={entries} env={env} />;
}

function GroupLibraryOn({ entries, env }: { entries: readonly LibraryEntry[]; env: GroupEnv }) {
  const i18n = useI18n();
  const { t } = i18n;
  const connection = useConnection();
  const exit = useGroupExit();
  const [view, setView] = useState<View | null>(null);
  const [missingId, setMissingId] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // A pasted QR link wasn't used (#25 AC57): sticky, above the in-group notice.
  // A repeat paste shows it again (a new key: replaced, announced again).
  const [qrPasted, setQrPasted] = useState(0);
  usePastedLinkNotice(env.pastedLinks, true, () => setQrPasted((n) => n + 1));
  // A tab in a group comes back to it here too (AC34).
  useResume(env, true, () => undefined);
  const snapshot = useSyncSnapshot();
  const group = snapshot.group?.status === 'active' ? snapshot.group : null;

  const onAdmitted = useCallback(
    (joined: JoinedGroup) => {
      env.pointers.write({ groupId: joined.groupId, mode: 'following', ack: null, qrShown: false });
      const leaderBook = parseLeaderMetadata(joined.metadata);
      // Look the book up in the local catalogue; never navigate to the leader's string (R6).
      const local =
        leaderBook !== null ? env.bundledIds.find((id) => id === leaderBook.contentId) : undefined;
      if (local !== undefined) {
        setView('opening');
        // Close the socket cleanly (tokens kept), then open the book page,
        // which resumes by token (architecture 8.3).
        connection.disconnect();
        browserNavigation.assign(bookHref(local));
        return;
      }
      setMissingId(leaderBook?.contentId ?? null);
      setView('missing');
    },
    [env.pointers, env.bundledIds, connection],
  );
  const join = useJoin({ onAdmitted, onError: () => setView('join') });
  const waitLeft = useWaitLeft(join.error);
  const waiting = join.waitingUntil !== null;
  const shownView: View | null = view === 'join' && waiting ? 'waiting' : view;

  const open = () => {
    if (connection.status === 'idle' || connection.status === 'closed') connection.connect();
    join.backToCode();
    setView('join');
  };

  let content: SheetContent | null = null;
  if (shownView === 'join' && join.step === 'code') {
    const allowed =
      connection.state.status === 'connected' ? connection.state.joinMethods : ['A', 'B', 'C'];
    const digits = allowed.includes('A') || allowed.includes('B');
    content = {
      key: 'join-code',
      title: t.joinTitle,
      body: (
        <>
          <JoinForm
            code={join.code}
            onCodeChange={join.setCode}
            name={join.name}
            onNameChange={join.setName}
            lettersToggle={digits && allowed.includes('C')}
            lettersOnly={!digits && allowed.includes('C')}
            fieldError={
              join.error?.view.focus === 'name' ? { field: 'name', text: t.nameInvalidChars } : null
            }
            onSubmit={join.submitCode}
          />
          {join.error !== null && join.error.view.focus !== 'name' ? (
            <JoinErrorMessage error={join.error} />
          ) : null}
        </>
      ),
      footer: (
        <Button
          type="submit"
          form={JOIN_FORM_ID}
          variant="primary"
          pending={join.pending}
          pendingLabel={t.joining}
          inactive={waitLeft > 0}
        >
          {t.joinSubmit}
        </Button>
      ),
    };
  } else if (shownView === 'join') {
    content = {
      key: 'join-door',
      title: t.doorTitle,
      onBack: join.backToCode,
      body: (
        <>
          <DoorForm
            code={join.code}
            door={join.door}
            onDoorChange={join.setDoor}
            error={join.error?.view.focus === 'door' ? t.errDoorWrong : null}
            onChangeCode={join.backToCode}
            onSubmit={join.submitDoor}
          />
          {join.error !== null && join.error.view.focus !== 'door' ? (
            <JoinErrorMessage error={join.error} />
          ) : null}
        </>
      ),
      footer: (
        <Button
          type="submit"
          form={DOOR_FORM_ID}
          variant="primary"
          pending={join.pending}
          pendingLabel={t.joining}
        >
          {t.joinSubmit}
        </Button>
      ),
    };
  } else if (shownView === 'waiting' && join.waitingUntil !== null) {
    content = {
      key: 'waiting',
      title: t.waitingTitle,
      body: <WaitingBody expiresAt={join.waitingUntil} />,
      footer: (
        <Button
          pending={join.cancelPending}
          pendingLabel={t.cancelRequest}
          onClick={join.cancelRequest}
        >
          {t.cancelRequest}
        </Button>
      ),
    };
  } else if (shownView === 'opening') {
    content = {
      key: 'opening',
      title: t.openingGroupBook,
      body: (
        <p className={styles.qrState} role="status">
          <span className={styles.spinner} aria-hidden="true" />
        </p>
      ),
    };
  } else if (shownView === 'missing') {
    content = {
      key: 'missing',
      title: t.groupBookMissingTitle,
      body: (
        <div className={styles.stack}>
          <p className={styles.para}>{t.groupBookMissingBody}</p>
          {missingId !== null ? (
            <details>
              <summary>{t.details}</summary>
              <p className={styles.para}>
                {t.groupBookIdLabel} <PlainText text={missingId} dir="ltr" maxLength={40} />
              </p>
            </details>
          ) : null}
        </div>
      ),
      footer: (
        <Button
          variant="primary"
          pending={exit.leave.pending}
          pendingLabel={t.leaving}
          onClick={() => {
            void exit.leave.run().then((result) => {
              if (!result.ok) return;
              env.pointers.forget();
              setView(null);
            });
          }}
        >
          {t.leaveGroup}
        </Button>
      ),
    };
  }

  // In a group: say which book, offer it when bundled (design 6.10).
  const groupBook = group !== null ? parseLeaderMetadata(group.metadata) : null;
  const groupEntry =
    groupBook !== null
      ? entries.find((entry) => entry.contentId === groupBook.contentId)
      : undefined;
  const inGroupNotice =
    group !== null ? (
      <NoticeBar dismissLabel={t.dismiss}>
        {groupEntry !== undefined ? (
          <>
            {t.libraryInGroup.split('{title}')[0]}
            {groupEntry.title !== undefined ? (
              <PlainText text={groupEntry.title} dir={groupEntry.dir} singleLine />
            ) : (
              <PlainText text={groupEntry.contentId} dir="ltr" />
            )}
            {t.libraryInGroup.split('{title}')[1]}{' '}
            <Button
              variant="text"
              onClick={() => {
                env.pointers.update({ mode: 'following' });
                connection.disconnect();
                browserNavigation.assign(bookHref(groupEntry.contentId));
              }}
            >
              {t.openGroupBook}
            </Button>
          </>
        ) : (
          t.memberGroupTitle
        )}
      </NoticeBar>
    ) : null;

  const notices =
    qrPasted > 0 || inGroupNotice !== null ? (
      <>
        {qrPasted > 0 ? (
          <NoticeBar key={qrPasted} dismissLabel={t.dismiss} onDismiss={() => setQrPasted(0)}>
            {t.noticeQrPasted}
          </NoticeBar>
        ) : null}
        {inGroupNotice}
      </>
    ) : null;

  return (
    <>
      <LibraryScreen
        entries={entries}
        notice={notices}
        headerAction={
          group !== null ? (
            // A leader ends the group from the book, with its confirmation (AC32).
            group.role === 'member' ? (
              <Button
                ref={buttonRef}
                className={styles.libraryAction}
                pending={exit.leave.pending}
                pendingLabel={t.leaving}
                onClick={() => {
                  void exit.leave.run().then((result) => {
                    if (result.ok) env.pointers.forget();
                  });
                }}
              >
                {t.leaveGroup}
              </Button>
            ) : null
          ) : (
            <Button ref={buttonRef} className={styles.libraryAction} onClick={open}>
              {t.joinGroup}
            </Button>
          )
        }
      />
      {content !== null ? (
        <GroupSheet
          content={content}
          onClose={() => setView(null)}
          returnFocus={() => buttonRef.current}
        />
      ) : null}
    </>
  );
}
