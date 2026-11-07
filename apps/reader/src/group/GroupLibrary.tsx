import { type JoinedGroup, useConnection, useGroupExit } from '@sync-system/react';
import { useCallback, useRef, useState } from 'react';
import { Button } from '../components/group/controls.js';
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
import { useJoin } from './use-join.js';

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

  return (
    <>
      <LibraryScreen
        entries={entries}
        headerAction={
          <Button ref={buttonRef} className={styles.libraryAction} onClick={open}>
            {t.joinGroup}
          </Button>
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
