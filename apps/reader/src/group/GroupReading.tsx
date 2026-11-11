import {
  type CreateGroupOptions,
  type SyncClientError,
  useConnection,
  useCreateGroup,
  useGroupExit,
  useJoinRequests,
  useGroupEnded,
  useLeaderCodes,
  usePosition,
  useRemoved,
  useQrTicket,
  useRoster,
  useSyncEvent,
  useSyncIndicator,
  useSyncSnapshot,
  useViceLeader,
} from '@sync-system/react';
import { type JoinedGroup, type ResumedGroup } from '@sync-system/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApprovalTray } from '../components/group/ApprovalTray.js';
import { BannerSlot } from '../components/group/BannerSlot.js';
import { ConfirmDialog } from '../components/group/ConfirmDialog.js';
import { Button, NoticeBar } from '../components/group/controls.js';
import { CREATE_FORM_ID, CreateGroupForm } from '../components/group/CreateGroupForm.js';
import { GroupButton } from '../components/group/GroupButton.js';
import {
  DOOR_FORM_ID,
  DoorForm,
  JOIN_FORM_ID,
  JoinErrorMessage,
  JoinForm,
  WaitingBody,
  useWaitLeft,
} from '../components/group/JoinViews.js';
import { GroupSheet, type SheetContent, startView } from '../components/group/GroupSheet.js';
import {
  CodeStrip,
  LeaderCodes,
  LeaderDetails,
  LockControl,
  LockLine,
  PreviewControl,
  qrOnly,
} from '../components/group/LeaderViews.js';
import { PreviewBanner } from '../components/group/PreviewBanner.js';
import { MismatchBlock, VersionWarnDialog } from '../components/group/MismatchViews.js';
import { PeopleCounter, PeopleRow, RosterList } from '../components/group/People.js';
import { JumpPrompt, LateJoinPrompt } from '../components/group/Prompts.js';
import { bookHref } from '../components/LibraryScreen.js';
import { QrCodeView } from '../components/group/QrCodeView.js';
import styles from '../components/group/group.module.css';
import { PlainText } from '../components/PlainText.js';
import { ARTICLE_ID, ReadingScreen, type ReadingScreenProps } from '../components/ReadingScreen.js';
import { compareContent } from '../content/compare.js';
import type { ContentSource } from '../content/loader.js';
import { parseLeaderMetadata, toGroupMetadata } from '../content/metadata.js';
import { documentDir } from '../direction/effective.js';
import { useI18n } from '../i18n/index.js';
import type { MoveSource } from '../navigation/use-page-navigation.js';
import { indicatorAnnouncement, useAnnouncer } from './announce.js';
import { formatLong } from './countdown.js';
import { browserNavigation } from './browser.js';
import { type GroupEnv, useGroupEnv } from './context.js';
import { type ShareTarget, buildJoinLink } from './deep-link.js';
import { errorText, errorView } from './errors.js';
import { ownNameText } from './names.js';
import { type IndicatorKind, derivePhase, indicatorFor } from './phase.js';
import { useBannerSlot } from './use-banner-slot.js';
import { useLeadershipFlow } from './use-leadership-flow.js';
import type { LeaderError } from './leader-errors.js';
import { usePreviewMode } from './use-preview-mode.js';
import type { Messages } from '../i18n/en.js';
import { encodePosition } from './position.js';
import { useFollow } from './use-follow.js';
import { useJoin } from './use-join.js';
import { useResume } from './use-resume.js';
import { decodePosition } from './position.js';
import type { GroupPointer } from './session-store.js';
import { useQrLanding } from './use-qr-landing.js';
import { useDocumentVisible } from './use-document-visible.js';
import { LARGE_SCREEN, useMediaQuery } from './use-media-query.js';

export type GroupReadingProps = Omit<
  ReadingScreenProps,
  | 'headerEndSlot'
  | 'overlay'
  | 'belowHeader'
  | 'banner'
  | 'notices'
  | 'aside'
  | 'blocked'
  | 'announce'
  | 'announceAssertive'
> & {
  /** Where the book came from: the QR link opens the same one (Decision Q4). */
  source?: ContentSource;
  /** The first page came from this tab's storage (a joiner is then not "fresh", U1). */
  restoredPage?: boolean;
};

/** Which sheet view is open (design 6). */
export type SheetView =
  | 'start'
  | 'create'
  | 'ready'
  | 'leader'
  | 'qr'
  | 'join'
  | 'waiting'
  | 'member'
  | 'qr-join'
  | 'people';

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

function GroupReadingOn({ source, restoredPage = false, ...props }: GroupReadingProps) {
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
  const requests = useJoinRequests();
  const large = useMediaQuery(LARGE_SCREEN);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const roster = useRoster();
  const counterRef = useRef<HTMLButtonElement>(null);
  // Focus was in the panel's list when the window shrank: it goes to the counter (F14.4).
  const focusCounterNext = useRef(false);
  useEffect(() => {
    if (large || !focusCounterNext.current) return;
    focusCounterNext.current = false;
    counterRef.current?.focus();
  }, [large]);
  const [sheet, setSheet] = useState<SheetView | null>(null);
  const [formError, setFormError] = useState<SyncClientError | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [announcement, announce] = useAnnouncer();
  const ownIndex = useRef(props.initialIndex ?? 0);
  const position = usePosition();
  const [restored] = useState(restoredPage);
  const turnedSinceLoad = useRef(false);
  const [jumpRequest, setJumpRequest] = useState<{ index: number; id: number } | null>(null);
  // A membership that comes back by resume keeps the tab's stored mode (Q3).
  // Set from the pointer at load: the group turns active before resumeGroup resolves.
  const resumedMode = useRef<'following' | 'browsing' | null>(env.pointers.read()?.mode ?? null);

  const onAdmitted = useCallback(
    (joined: JoinedGroup) => {
      env.pointers.write({ groupId: joined.groupId, mode: 'following', ack: null, qrShown: false });
      // A new admission, not a resume (F8 positioning).
      resumedMode.current = null;
      setSheet(null);
      announce(t.announceAdmitted);
    },
    [env.pointers, announce, t.announceAdmitted],
  );
  const join = useJoin({
    onAdmitted,
    // A result that needs an answer reopens the sheet (design F3.3).
    onError: () => setSheet('join'),
  });
  const landing = useQrLanding(env, onAdmitted);
  // Back to this tab's group after a reload (AC34, AC36); waits for a QR answer (L3).
  const onResumed = useCallback((resumed: ResumedGroup, pointer: GroupPointer) => {
    if (resumed.role === 'leader') {
      // The group's page wins for the leader (Decision Q3).
      const index = resumed.hasPosition ? decodePosition(resumed.position, doc.pages.length) : null;
      if (index !== null) setJumpRequest((prev) => ({ index, id: (prev?.id ?? 0) + 1 }));
    }
    void pointer;
    // No dependencies on purpose: doc.pages.length is fixed for this page.
  }, []);
  const resume = useResume(env, landing.state.status === 'none', onResumed);
  // A QR landing opens the sheet on "Joining the group…": zero taps (F5.4).
  const landingStatus = landing.state.status;
  useEffect(() => {
    if (landingStatus === 'joining' || landingStatus === 'failed') setSheet('qr-join');
  }, [landingStatus]);

  const group = snapshot.group;
  const isLeader = group?.status === 'active' && group.role === 'leader';
  const isMember = group?.status === 'active' && group.role === 'member';
  const vice = useViceLeader();
  // The banner slot (#25 architecture 6): one banner, dropped when no longer true.
  const banners = useBannerSlot(
    {
      isLeader,
      isVice: vice.isVice,
      locked: group?.status === 'active' && group.locked,
      inGroup:
        group !== null &&
        (group.status === 'active' || group.status === 'rejoining' || group.status === 'waiting'),
    },
    announce,
  );
  const showEnded = banners.show;
  const endedNotice = (text: keyof Messages, focus = false) =>
    showEnded({ row: 1, kind: 'ended', text, focus });
  const locked = group?.status === 'active' && group.locked;
  useLeadershipFlow({ isMember, isVice: vice.isVice, show: banners.show });
  // The content check runs before anything is followed (AC21, item 7 compare).
  const memberMetadata = isMember ? group.metadata : null;
  const compare = useMemo(
    () =>
      memberMetadata === null ? null : compareContent(content.metadata, memberMetadata).result,
    [memberMetadata, content.metadata],
  );
  // The version warning's answer lasts for this leader text in this tab (F6).
  const [ack, setAck] = useState(() => env.pointers.read()?.ack ?? null);
  const leaderBook = useMemo(() => parseLeaderMetadata(memberMetadata), [memberMetadata]);
  const acknowledged = ack !== null && leaderBook !== null && ack === leaderBook.fingerprint;
  const phase = derivePhase({
    enabled: true,
    connection: snapshot.connection,
    group,
    joining: create.pending || join.pending,
    resuming: resume.status === 'pending' && landing.state.status === 'none',
    hasPointer: env.pointers.read() !== null,
    compare,
    acknowledged,
    resumeFailed: resume.status === 'failed',
  });
  // "Open the group's book": the local catalogue's ID, found by lookup (R6, U2).
  const localGroupBook =
    leaderBook !== null && !env.singleBook
      ? env.bundledIds.find((id) => id === leaderBook.contentId)
      : undefined;

  const lastExit = useRef<'end' | 'leave' | null>(null);
  // A failed leave says so next to the Leave button used (design 7.5, F12);
  // kept per group so a later group never shows an old failure.
  const [leaveFailedFor, setLeaveFailedFor] = useState<string | null>(null);
  const currentGroupId = group !== null && 'groupId' in group ? group.groupId : null;
  const leaveError =
    leaveFailedFor !== null && leaveFailedFor === currentGroupId ? t.leaveFailed : null;
  const leaveGroup = () => {
    if (phase === 'disconnected') {
      // Not connected: forget the group in this tab (token and pointer, R5).
      resume.forget();
      join.clear();
      setSheet(null);
      endedNotice('leftGroup');
      return;
    }
    lastExit.current = 'leave';
    setLeaveFailedFor(null);
    const leaving = currentGroupId;
    void exit.leave.run().then((result) => {
      if (!result.ok) {
        lastExit.current = null;
        setLeaveFailedFor(leaving);
        return;
      }
      env.pointers.forget();
      join.clear();
      setSheet(null);
    });
  };
  const openGroupBook = () => {
    if (localGroupBook === undefined) return;
    env.pointers.update({ mode: 'following' });
    // A clean close keeps the tokens; the book page resumes by token (8.3).
    connection.disconnect();
    browserNavigation.assign(bookHref(localGroupBook));
  };
  const followAnyway = () => {
    if (leaderBook === null) return;
    setAck(leaderBook.fingerprint);
    env.pointers.update({ ack: leaderBook.fingerprint });
  };
  const followed = useFollow({
    active: phase === 'member' && isMember,
    membership: isMember ? group.groupId : null,
    pageCount: doc.pages.length,
    ownIndex: () => ownIndex.current,
    fresh: () => !turnedSinceLoad.current && !restored,
    lateJoinMs: env.sync.lateJoinSeconds * 1000,
    resumedMode: () => resumedMode.current,
    onJump: (index) => setJumpRequest((prev) => ({ index, id: (prev?.id ?? 0) + 1 })),
    onMode: (mode) => env.pointers.update({ mode }),
  });
  // The leader's preview (#25 architecture 7.3): routed by the core's live state.
  const previewMode = usePreviewMode(doc.pages.length);
  const previewing = isLeader && previewMode.active;
  const [previewError, setPreviewError] = useState<LeaderError | null>(null);
  const previewActive = previewMode.active;
  useEffect(() => {
    if (!previewActive) setPreviewError(null);
  }, [previewActive]);
  // The group's official page, for the leader's sends and the preview banner.
  const groupIndex = position.hasPosition
    ? decodePosition(position.position, doc.pages.length)
    : null;
  const groupIndexRef = useRef(groupIndex);
  groupIndexRef.current = groupIndex;
  const kind = indicatorFor(phase, clientIndicator, followed.state.mode, previewing);
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
      groupIndex: groupIndexRef.current,
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
    setSheet((view) =>
      view === 'ready' || view === 'leader' || view === 'create' || view === 'people' ? null : view,
    );
  }, [isLeader]);

  const pageChanged = useCallback(
    (index: number, source: MoveSource) => {
      ownIndex.current = index;
      onPageChange?.(index, source);
      if (source === 'user') {
        turnedSinceLoad.current = true;
        followed.userTurned(index);
      }
      // Previewing: a preview move, never a position update (#25 AC41, R21).
      if (previewMode.isActiveNow()) {
        previewMode.move(index);
        return;
      }
      // The leader's page is the group's (AC25); only real moves are sent
      // (#25 7.3); the client throttles (trailing send).
      if (position.canUpdate && groupIndexRef.current !== index) {
        position.updatePosition(encodePosition(index));
      }
    },
    [onPageChange, followed, position, previewMode],
  );

  const startPreview = () => {
    setSheet(null);
    setPreviewError(null);
    previewMode.start(ownIndex.current);
  };
  const returnFromPreview = () => {
    const index = previewMode.returnToGroup();
    setPreviewError(null);
    if (index !== null && index !== ownIndex.current) {
      setJumpRequest((prev) => ({ index, id: (prev?.id ?? 0) + 1 }));
    }
    announce(t.announcePreviewOff);
    focusArticle();
  };
  const bringGroupHere = () => {
    const view = previewMode.viewIndex ?? ownIndex.current;
    const error = previewMode.bring(isLeader);
    setPreviewError(error);
    if (error !== null) return;
    announce(i18n.format(t.announceGroupMoved, { n: view + 1 }));
    focusArticle();
  };
  const previewBanner = previewing ? (
    <PreviewBanner
      groupIndex={groupIndex}
      viewIndex={previewMode.viewIndex ?? ownIndex.current}
      error={previewError}
      onReturn={returnFromPreview}
      onBring={bringGroupHere}
    />
  ) : null;

  // Prompts are announced once when they appear or change (design 6.13, 6.14).
  const late = followed.state.late;
  const jump = followed.state.jump;
  const lateShown = late !== null;
  useEffect(() => {
    if (late === null) return;
    announce(
      i18n.format(t.announceLateJoin, {
        n: late.index + 1,
        time: formatLong(env.sync.lateJoinSeconds * 1000, i18n),
      }),
    );
    // Only on appearance; the page in it may change later.
  }, [lateShown]);
  useEffect(() => {
    if (jump !== null) announce(i18n.format(t.announceJump, { n: jump.index + 1 }));
  }, [jump, announce, i18n, t.announceJump]);

  const ensureConnected = () => {
    if (connection.status === 'idle' || connection.status === 'closed') connection.connect();
  };

  // A method B request waits for approval: the sheet shows it (design F3).
  const waiting = join.waitingUntil !== null;
  useEffect(() => {
    if (waiting) setSheet((view) => (view === 'join' ? 'waiting' : view));
    else setSheet((view) => (view === 'waiting' ? 'join' : view));
  }, [waiting]);

  // The group ended: say why, forget it, close everything; the book stays (AC33, F12).
  const ended = useGroupEnded();
  const removed = useRemoved();
  const resumedThisLoad = resume.status === 'done';
  useEffect(() => {
    if (ended === null && !removed) return;
    const reason = removed ? 'removed' : ended!.reason;
    if (reason === 'closed') return;
    env.pointers.forget();
    resumedMode.current = null;
    const key = (
      {
        ended_by_leader: 'endedByLeader',
        leader_timeout: 'endedLeaderTimeout',
        max_session: 'endedMaxSession',
        inactivity: 'endedInactivity',
        removed: 'endedRemoved',
        replaced: 'endedReplaced',
        left: lastExit.current === 'end' ? 'endedByYou' : 'leftGroup',
        rejoin_failed: resumedThisLoad ? 'endedRejoinFailed' : 'storedGroupGone',
      } as const
    )[reason];
    lastExit.current = null;
    const focus = document.activeElement?.closest('dialog, [role="region"]') != null;
    setSheet(null);
    setConfirm(null);
    join.clear();
    endedNotice(key, focus);
    announce(t[key]);
    // Only `ended` and `removed` on purpose: one notice per end, not a
    // repeat when the text, pointers or join state change.
  }, [ended, removed]);

  // A stored group that is gone: one short notice, never retried (AC37).
  useEffect(() => {
    if (resume.status === 'gone' || resume.status === 'none') resumedMode.current = null;
    if (resume.status === 'gone') showEnded({ row: 1, kind: 'ended', text: 'storedGroupGone' });
  }, [resume.status, showEnded]);

  const openSheet = () => {
    if (phase === 'leader') setSheet('leader');
    else if (phase === 'awaiting') setSheet('waiting');
    else if (phase === 'joining') setSheet('join');
    else if (phase === 'disconnected') setSheet('member');
    else if (
      group?.status === 'active' ||
      group?.status === 'rejoining' ||
      group?.status === 'waiting'
    ) {
      setSheet('member');
    } else setSheet('start');
  };
  const waitLeft = useWaitLeft(join.error);

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
    lastExit.current = 'end';
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
  const rosterList = (onUnmountWithFocus?: () => void) => (
    <RosterList
      roster={roster}
      viceId={vice.viceId}
      stale={connection.status !== 'connected'}
      announce={announce}
      {...(onUnmountWithFocus !== undefined ? { onUnmountWithFocus } : {})}
    />
  );
  const leaderDetails = (top?: ReactNode, qrPart?: ReactNode, people?: ReactNode) => (
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
      locked={locked}
      controls={
        <>
          <PreviewControl
            active={previewMode.active}
            onStart={startPreview}
            onReturn={returnFromPreview}
          />
          <LockControl announce={announce} />
        </>
      }
      {...(people !== undefined ? { people } : {})}
      {...(sheet === 'leader' || sheet === 'ready'
        ? { peopleRow: <PeopleRow roster={roster} onShow={() => setSheet('people')} /> }
        : {})}
    />
  );

  // Join requests: overlay on phones, top of the panel on large screens (6.15).
  const tray =
    isLeader && requests.requests.length > 0 ? (
      <ApprovalTray requests={requests} announce={announce} />
    ) : null;

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
      onJoin: () => {
        ensureConnected();
        join.backToCode();
        setSheet('join');
      },
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
  } else if (sheet === 'join' && join.step === 'code') {
    const allowed =
      connection.state.status === 'connected' ? connection.state.joinMethods : ['A', 'B', 'C'];
    const digits = allowed.includes('A') || allowed.includes('B');
    const fieldFocus = join.error?.view.focus;
    content2 = {
      key: 'join-code',
      title: t.joinTitle,
      onBack: () => {
        join.backToCode();
        setSheet('start');
      },
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
              join.error !== null && fieldFocus === 'name'
                ? { field: 'name', text: t.nameInvalidChars }
                : null
            }
            onSubmit={join.submitCode}
          />
          {join.error !== null && fieldFocus !== 'name' ? (
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
  } else if (sheet === 'join' && join.step === 'door') {
    content2 = {
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
          inactive={waitLeft > 0}
        >
          {t.joinSubmit}
        </Button>
      ),
    };
  } else if (sheet === 'waiting' && join.waitingUntil !== null) {
    content2 = {
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
  } else if (sheet === 'member' && phase === 'disconnected') {
    content2 = {
      key: 'disconnected',
      title: t.memberGroupTitle,
      body: <p className={styles.para}>{t.announceDisconnected}</p>,
      footer: (
        <>
          <Button pending={exit.leave.pending} pendingLabel={t.leaving} onClick={leaveGroup}>
            {t.leaveGroup}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setSheet(null);
              resume.retry();
              if (connection.status === 'closed') connection.retry();
            }}
          >
            {t.tryAgain}
          </Button>
        </>
      ),
    };
  } else if (sheet === 'member' && group !== null && group.status !== 'ended') {
    content2 = {
      key: 'member',
      title: t.memberGroupTitle,
      body: (
        <div className={styles.stack}>
          <p className={styles.para}>
            {t.groupBookLabel}{' '}
            {doc.title !== undefined ? (
              <PlainText text={doc.title} dir={documentDir(doc)} singleLine />
            ) : (
              <PlainText text={doc.contentId} dir="ltr" />
            )}
          </p>
          {ownName !== null ? (
            <p className={styles.para}>
              {i18n.format(t.yourName, { name: '\u0000' }).split('\u0000')[0]}
              <PlainText text={ownName} dir="auto" maxLength={32} />
            </p>
          ) : null}
          {vice.isVice ? <p className={styles.para}>{t.memberViceLine}</p> : null}
          {locked ? <LockLine member /> : null}
          {followed.state.mode === 'browsing' &&
          followed.groupIndex !== null &&
          followed.groupIndex !== ownIndex.current ? (
            <>
              <p className={styles.para}>
                {i18n.format(t.groupOnPage, { n: followed.groupIndex + 1 })}
              </p>
              <Button
                variant="primary"
                onClick={() => {
                  setSheet(null);
                  followed.goToGroup();
                }}
              >
                {i18n.format(t.goToPage, { n: followed.groupIndex + 1 })}
              </Button>
            </>
          ) : null}
          {leaveError !== null ? (
            <p role="alert" className={styles.formError}>
              {leaveError}
            </p>
          ) : null}
        </div>
      ),
      footer: (
        <Button pending={exit.leave.pending} pendingLabel={t.leaving} onClick={leaveGroup}>
          {t.leaveGroup}
        </Button>
      ),
    };
  } else if (sheet === 'qr-join' && landing.state.status === 'joining') {
    content2 = {
      key: 'qr-joining',
      title: t.qrJoiningTitle,
      body: (
        <p className={styles.qrState} role="status">
          <span className={styles.spinner} aria-hidden="true" />
        </p>
      ),
    };
  } else if (sheet === 'qr-join' && landing.state.status === 'failed') {
    const view = errorView(landing.state.error);
    content2 = {
      key: 'qr-failed',
      title: t.qrJoinFailedTitle,
      body:
        view !== null ? (
          <JoinErrorMessage error={{ view: { ...view, focus: 'heading' }, retryAt: null }} />
        ) : null,
      footer: (
        <>
          <Button
            onClick={() => {
              landing.dismiss();
              setSheet(null);
            }}
          >
            {t.readOnMyOwn}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              landing.dismiss();
              ensureConnected();
              join.backToCode();
              setSheet('join');
            }}
          >
            {t.joinWithCode}
          </Button>
        </>
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
  } else if (sheet === 'people' && isLeader) {
    content2 = {
      key: 'people',
      title: t.peopleTitle,
      onBack: () => setSheet('leader'),
      body: rosterList(),
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
        locked={locked}
        counter={
          <PeopleCounter ref={counterRef} roster={roster} onOpen={() => setSheet('people')} />
        }
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
          <>
            {tray}
            {noticeBars}
          </>,
          hasQr ? (
            <>
              {panelQr ? qrView : null}
              <Button onClick={() => setPanelQrShown(!panelQr)}>
                {panelQr ? t.hideQr : t.showQr}
              </Button>
            </>
          ) : undefined,
          rosterList(() => {
            focusCounterNext.current = true;
          }),
        )}
      </aside>
    ) : null;

  return (
    <>
      <ReadingScreen
        {...props}
        onPageChange={pageChanged}
        announce={announcement}
        jumpRequest={jumpRequest}
        headerEndSlot={
          kind === null ? null : (
            <GroupButton ref={buttonRef} kind={kind} graceEndsAt={graceEndsAt} onOpen={openSheet} />
          )
        }
        belowHeader={strip}
        banner={
          banners.shown !== null || previewBanner !== null ? (
            <BannerSlot slot={banners} preview={previewBanner} onDismissed={focusArticle} />
          ) : null
        }
        notices={large && isLeader ? null : noticeBars}
        aside={panel}
        blocked={
          phase === 'mismatch-block' &&
          (compare === 'different-content' || compare === 'unsupported-schema') ? (
            <MismatchBlock
              result={compare}
              leaderMetadata={memberMetadata}
              canOpen={localGroupBook !== undefined}
              leavePending={exit.leave.pending}
              leaveError={leaveError}
              onLeave={leaveGroup}
              onOpen={openGroupBook}
            />
          ) : null
        }
        overlay={
          late !== null || jump !== null || (!large && tray !== null) ? (
            <div className={styles.overlayStack}>
              {late !== null ? (
                <LateJoinPrompt
                  index={late.index}
                  deadline={late.deadline}
                  totalMs={env.sync.lateJoinSeconds * 1000}
                  onGo={followed.goToGroup}
                  onStay={followed.stayHere}
                  onExpired={followed.lateExpired}
                />
              ) : jump !== null ? (
                <JumpPrompt
                  index={jump.index}
                  onGo={followed.goToGroup}
                  onStay={followed.stayHere}
                />
              ) : null}
              {!large ? tray : null}
            </div>
          ) : null
        }
      />
      {content2 !== null ? (
        <GroupSheet
          content={content2}
          onClose={() => setSheet(null)}
          returnFocus={() => buttonRef.current}
        />
      ) : null}
      {phase === 'mismatch-warn' ? (
        <VersionWarnDialog
          leavePending={exit.leave.pending}
          leaveError={leaveError}
          onFollow={followAnyway}
          onLeave={leaveGroup}
        />
      ) : null}
      {landing.state.status === 'ask' ? (
        <ConfirmDialog
          title={t.switchGroupTitle}
          body={t.switchGroupBody}
          confirmLabel={t.switchGroupConfirm}
          cancelLabel={t.switchGroupKeep}
          pendingLabel={t.joining}
          tone="primary"
          pending={landing.state.pending}
          onConfirm={landing.switchGroup}
          onCancel={landing.stay}
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
