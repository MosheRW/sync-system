import {
  type CreateGroupOptions,
  type SyncClientError,
  useConnection,
  useCreateGroup,
  useGroupExit,
  useLeaderCodes,
  useQrTicket,
  useSyncEvent,
  useSyncIndicator,
  useSyncSnapshot,
} from '@sync-system/react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../components/group/ConfirmDialog.js';
import { Button, NoticeBar } from '../components/group/controls.js';
import { CREATE_FORM_ID, CreateGroupForm } from '../components/group/CreateGroupForm.js';
import { GroupButton } from '../components/group/GroupButton.js';
import { GroupSheet, type SheetContent, startView } from '../components/group/GroupSheet.js';
import { CodeStrip, LeaderCodes, LeaderDetails, qrOnly } from '../components/group/LeaderViews.js';
import { QrCodeView } from '../components/group/QrCodeView.js';
import styles from '../components/group/group.module.css';
import { ARTICLE_ID, ReadingScreen, type ReadingScreenProps } from '../components/ReadingScreen.js';
import type { ContentSource } from '../content/loader.js';
import { toGroupMetadata } from '../content/metadata.js';
import { documentDir } from '../direction/effective.js';
import { useI18n } from '../i18n/index.js';
import type { MoveSource } from '../navigation/use-page-navigation.js';
import { indicatorAnnouncement, useAnnouncer } from './announce.js';
import { type GroupEnv, useGroupEnv } from './context.js';
import { type ShareTarget, buildJoinLink } from './deep-link.js';
import { errorText, errorView } from './errors.js';
import { ownNameText } from './names.js';
import { type IndicatorKind, derivePhase, indicatorFor } from './phase.js';
import { encodePosition } from './position.js';
import { useDocumentVisible } from './use-document-visible.js';
import { LARGE_SCREEN, useMediaQuery } from './use-media-query.js';

export type GroupReadingProps = Omit<
  ReadingScreenProps,
  'headerEndSlot' | 'overlay' | 'belowHeader' | 'notices' | 'aside' | 'blocked' | 'announce'
> & {
  /** Where the book came from: the QR link opens the same one (Decision Q4). */
  source?: ContentSource;
};

/** Which sheet view is open (design 6). */
export type SheetView = 'start' | 'create' | 'ready' | 'leader' | 'qr';

/** The book a join link opens, from validated values only (R4). */
function shareTargetOf(
  env: GroupEnv,
  source: ContentSource | undefined,
  contentId: string,
): ShareTarget {
  if (env.singleBook) return { kind: 'single-book' };
  if (source?.kind === 'url') return { kind: 'src', url: source.url, srcOrigins: env.srcOrigins };
  return { kind: 'book', contentId };
}

type Confirm = 'rotate' | 'end' | null;

/** Focus the article (design 9: where focus goes when a prompt or notice goes). */
export function focusArticle(): void {
  document.getElementById(ARTICLE_ID)?.focus();
}

/**
 * The reading page with groups (#24): the Group button and indicator, the
 * Group sheet, the leader's codes and, in later parts, prompts and follow
 * logic. The book itself stays `ReadingScreen`'s; this only fills its slots.
 * Without sync, or after "Read without a group", it is the solo reader.
 */
export function GroupReading(props: GroupReadingProps) {
  const env = useGroupEnv();
  // ReadingScreen ignores `source`.
  if (env === null || env.groupsDisabled) return <ReadingScreen {...props} />;
  return <GroupReadingOn {...props} />;
}

function GroupReadingOn({ source, ...props }: GroupReadingProps) {
  const env = useGroupEnv()!;
  const i18n = useI18n();
  const { t } = i18n;
  const { content, onPageChange } = props;
  const visible = useDocumentVisible();
  const [panelQr, setPanelQr] = useState(() => env.pointers.read()?.qrShown ?? false);
  const [hasQr, setHasQr] = useState(true);
  const doc = content.document;
  const snapshot = useSyncSnapshot();
  const clientIndicator = useSyncIndicator();
  const connection = useConnection();
  const create = useCreateGroup();
  const leader = useLeaderCodes();
  const exit = useGroupExit();
  const large = useMediaQuery(LARGE_SCREEN);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [sheet, setSheet] = useState<SheetView | null>(null);
  const [formError, setFormError] = useState<SyncClientError | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, announce] = useAnnouncer();
  const ownIndex = useRef(props.initialIndex ?? 0);

  const group = snapshot.group;
  const isLeader = group?.status === 'active' && group.role === 'leader';
  const phase = derivePhase({
    enabled: true,
    connection: snapshot.connection,
    group,
    joining: create.pending,
    resuming: false,
    hasPointer: false,
    compare: null,
    acknowledged: false,
  });
  const kind = indicatorFor(phase, clientIndicator, 'following');
  const graceEndsAt =
    group?.status === 'active' && group.leader.status !== 'online'
      ? (group.leader.graceEndsAt ?? null)
      : null;

  // Announce indicator changes once each (design 5.2, AC30).
  const shownKind = useRef<IndicatorKind | null>(null);
  const leadingAnnounced = useRef<string | null>(null);
  useEffect(() => {
    if (kind === null) return;
    const groupId = group !== null && 'groupId' in group ? group.groupId : null;
    const text = indicatorAnnouncement(shownKind.current, kind, i18n, {
      graceMs: graceEndsAt === null ? null : graceEndsAt - Date.now(),
      leadingAnnounced: groupId !== null && leadingAnnounced.current === groupId,
    });
    shownKind.current = kind;
    if (kind === 'leading' && groupId !== null) leadingAnnounced.current = groupId;
    if (text !== null) announce(text);
  }, [kind, i18n, graceEndsAt, announce, group]);

  // Codes changed: say why, in words (design F10.1, AC9); `created` is silent.
  useSyncEvent('codesChanged', (event) => {
    const text = {
      created: null,
      rotated: t.codesRotated,
      door_failures: t.codesDoorFailures,
      member_removed: t.codesMemberRemoved,
      superseded: t.codesSuperseded,
      resumed: t.codesResumed,
    }[event.reason];
    if (text === null) return;
    setNotice(text);
    announce(text);
  });

  // Door-code joining works again (F10.3): announced, hidden after 10 s.
  const paused = isLeader ? (leader.joinPaused?.retryAt ?? null) : null;
  const wasPaused = useRef(false);
  const [resumedNotice, setResumedNotice] = useState(false);
  useEffect(() => {
    if (paused !== null) {
      wasPaused.current = true;
      return undefined;
    }
    if (!wasPaused.current) return undefined;
    wasPaused.current = false;
    setResumedNotice(true);
    announce(t.joinResumedLeader);
    const timer = setTimeout(() => setResumedNotice(false), 10_000);
    return () => clearTimeout(timer);
  }, [paused, announce, t.joinResumedLeader]);

  // Leader-only parts go with the lead (AC13, design F13).
  useEffect(() => {
    if (isLeader) return;
    setNotice(null);
    setResumedNotice(false);
    setConfirm(null);
    setSheet((view) => (view === 'ready' || view === 'leader' || view === 'create' ? null : view));
  }, [isLeader]);

  const pageChanged = useCallback(
    (index: number, source: MoveSource) => {
      ownIndex.current = index;
      onPageChange?.(index, source);
    },
    [onPageChange],
  );

  const ensureConnected = () => {
    if (connection.status === 'idle' || connection.status === 'closed') connection.connect();
  };

  const openSheet = () => {
    if (phase === 'leader') setSheet('leader');
    else setSheet('start');
  };

  const submitCreate = (options: CreateGroupOptions) => {
    setFormError(null);
    void create
      .run(toGroupMetadata(content.metadata), encodePosition(ownIndex.current), options)
      .then((result) => {
        if (!result.ok) {
          setFormError(result.error);
          return;
        }
        const withQr = result.value.joinMethods.includes('D');
        env.pointers.write({
          groupId: result.value.groupId,
          mode: 'following',
          ack: null,
          qrShown: withQr,
        });
        setHasQr(withQr);
        setPanelQr(withQr);
        setSheet('ready');
      });
  };

  const runEnd = () => {
    void exit.end.run().then((result) => {
      if (!result.ok) return;
      env.pointers.forget();
      setConfirm(null);
      setSheet(null);
    });
  };

  const runRotate = () => {
    void leader.rotate.run().then((result) => {
      if (result.ok) setConfirm(null);
    });
  };

  // The QR is issued only while it is on screen and the tab is visible (AC12).
  const qrOnScreen =
    isLeader &&
    hasQr &&
    (sheet === 'ready' || sheet === 'qr' || (large && panelQr && sheet === null));
  const qr = useQrTicket({ enabled: qrOnScreen && visible });
  const target = shareTargetOf(env, source, doc.contentId);
  const linkFor = (ticket: string) => buildJoinLink(window.location.origin, target, ticket);
  const hasCodes = leader.codes !== null && !qrOnly(leader.codes);
  const offline = connection.status !== 'connected';
  const qrView = (
    <div className={styles.stack}>
      <QrCodeView state={qr.state} linkFor={linkFor} offline={offline} hasCodes={hasCodes} />
      <p className={styles.muted}>{t.qrTitle}</p>
    </div>
  );
  const setPanelQrShown = (shown: boolean) => {
    setPanelQr(shown);
    env.pointers.update({ qrShown: shown });
  };

  const ownName =
    group?.status === 'active'
      ? ownNameText(group.displayName, group.generated, t, i18n.format)
      : null;
  const leaderDetails = (top?: ReactNode, qrPart?: ReactNode) => (
    <LeaderDetails
      codes={leader.codes}
      pausedUntil={paused}
      name={ownName}
      qr={qrPart}
      rotatePending={leader.rotate.pending}
      endPending={exit.end.pending}
      onRotate={() => setConfirm('rotate')}
      onEnd={() => setConfirm('end')}
      top={top}
    />
  );

  const noticeBars = (
    <>
      {isLeader && notice !== null ? (
        <NoticeBar
          dismissLabel={t.dismiss}
          onDismiss={() => {
            setNotice(null);
            focusArticle();
          }}
        >
          {notice}
        </NoticeBar>
      ) : null}
      {isLeader && resumedNotice ? (
        <NoticeBar dismissLabel={t.dismiss}>{t.joinResumedLeader}</NoticeBar>
      ) : null}
    </>
  );

  const formErrorView = formError !== null ? errorView(formError) : null;
  let content2: SheetContent | null = null;
  if (sheet === 'start') {
    content2 = startView({
      canStart: true,
      onStart: () => {
        ensureConnected();
        setFormError(null);
        setSheet('create');
      },
      onJoin: () => undefined,
      t,
    });
  } else if (sheet === 'create') {
    const allowed = connection.state.status === 'connected' ? connection.state.joinMethods : null;
    content2 = {
      key: 'create',
      title: t.startGroup,
      onBack: () => setSheet('start'),
      body: (
        <>
          <CreateGroupForm
            allowed={allowed}
            defaultHandoff={
              connection.state.status === 'connected' ? connection.state.defaultHandoff : 'auto'
            }
            graceSeconds={
              connection.state.status === 'connected'
                ? connection.state.limits.disconnectGraceSeconds
                : null
            }
            title={doc.title}
            contentId={doc.contentId}
            docDir={documentDir(doc)}
            docLang={doc.lang}
            nameError={formErrorView?.focus === 'name' ? t.nameInvalidChars : null}
            onSubmit={submitCreate}
          />
          {formErrorView !== null && formErrorView.focus !== 'name' ? (
            <p role="alert" className={styles.formError}>
              {formErrorView.key === 'errServer' ? t.createFailed : errorText(formErrorView, i18n)}
            </p>
          ) : null}
        </>
      ),
      footer: (
        <Button
          type="submit"
          form={CREATE_FORM_ID}
          variant="primary"
          pending={create.pending}
          pendingLabel={t.starting}
          inactive={allowed === null}
        >
          {t.startGroupSubmit}
        </Button>
      ),
    };
  } else if (sheet === 'ready' && isLeader) {
    content2 = {
      key: 'ready',
      title: t.groupReadyTitle,
      body: (
        <>
          <p className={styles.para}>{t.groupReadyBody}</p>
          {leaderDetails(undefined, hasQr ? qrView : undefined)}
        </>
      ),
      footer: (
        <Button variant="primary" onClick={() => setSheet(null)}>
          {t.startReading}
        </Button>
      ),
    };
  } else if (sheet === 'leader' && isLeader) {
    content2 = {
      key: 'leader',
      title: t.yourGroupTitle,
      body: leaderDetails(
        undefined,
        hasQr ? <Button onClick={() => setSheet('qr')}>{t.showQr}</Button> : undefined,
      ),
    };
  } else if (sheet === 'qr' && isLeader) {
    content2 = {
      key: 'qr',
      title: t.qrTitle,
      onBack: () => setSheet(null),
      body: (
        <div className={styles.stack}>
          <QrCodeView state={qr.state} linkFor={linkFor} offline={offline} hasCodes={hasCodes} />
          <p className={styles.para}>{t.qrHint}</p>
          {leader.codes !== null ? <LeaderCodes codes={leader.codes} large /> : null}
        </div>
      ),
    };
  }

  const strip =
    isLeader && !large && leader.codes !== null ? (
      <CodeStrip
        codes={leader.codes}
        pausedUntil={paused}
        {...(hasQr
          ? {
              qrButton: (
                <Button
                  aria-label={t.showQr}
                  variant={qrOnly(leader.codes) ? 'primary' : 'secondary'}
                  onClick={() => setSheet('qr')}
                >
                  {qrOnly(leader.codes) ? t.showQr : t.qrButton}
                </Button>
              ),
            }
          : {})}
      />
    ) : null;
  const panel =
    isLeader && large ? (
      <aside className={styles.panel} aria-label={t.yourGroupTitle}>
        <h2 className={styles.panelHeading}>{t.yourGroupTitle}</h2>
        {leaderDetails(
          noticeBars,
          hasQr ? (
            <>
              {panelQr ? qrView : null}
              <Button onClick={() => setPanelQrShown(!panelQr)}>
                {panelQr ? t.hideQr : t.showQr}
              </Button>
            </>
          ) : undefined,
        )}
      </aside>
    ) : null;

  return (
    <>
      <ReadingScreen
        {...props}
        onPageChange={pageChanged}
        announce={announcement}
        headerEndSlot={
          kind === null ? null : (
            <GroupButton ref={buttonRef} kind={kind} graceEndsAt={graceEndsAt} onOpen={openSheet} />
          )
        }
        belowHeader={strip}
        notices={large ? null : noticeBars}
        aside={panel}
      />
      {content2 !== null ? (
        <GroupSheet
          content={content2}
          onClose={() => setSheet(null)}
          returnFocus={() => buttonRef.current}
        />
      ) : null}
      {confirm === 'rotate' && isLeader ? (
        <ConfirmDialog
          title={t.rotateConfirmTitle}
          body={t.rotateConfirmBody}
          confirmLabel={t.rotateConfirm}
          pendingLabel={t.rotating}
          tone="primary"
          pending={leader.rotate.pending}
          error={leader.rotate.error !== null ? t.rotateFailed : null}
          onConfirm={runRotate}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
      {confirm === 'end' && isLeader ? (
        <ConfirmDialog
          title={t.endConfirmTitle}
          body={t.endConfirmBody}
          confirmLabel={t.endGroup}
          pendingLabel={t.ending}
          tone="danger"
          pending={exit.end.pending}
          error={exit.end.error !== null ? t.endFailed : null}
          onConfirm={runEnd}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </>
  );
}
