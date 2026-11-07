import { useSyncIndicator, useSyncSnapshot } from '@sync-system/react';
import { useEffect, useRef, useState } from 'react';
import { GroupButton } from '../components/group/GroupButton.js';
import { GroupSheet, type SheetContent, startView } from '../components/group/GroupSheet.js';
import { ReadingScreen, type ReadingScreenProps } from '../components/ReadingScreen.js';
import { useI18n } from '../i18n/index.js';
import { indicatorAnnouncement, useAnnouncer } from './announce.js';
import { useGroupEnv } from './context.js';
import { type IndicatorKind, derivePhase, indicatorFor } from './phase.js';

export type GroupReadingProps = Omit<
  ReadingScreenProps,
  'headerEndSlot' | 'overlay' | 'belowHeader' | 'notices' | 'aside' | 'blocked' | 'announce'
>;

/** Which sheet view is open (design 6). */
export type SheetView = 'start';

/**
 * The reading page with groups (#24): the Group button and indicator, the
 * Group sheet and, in later parts, the leader's codes, prompts and follow
 * logic. The book itself stays `ReadingScreen`'s; this only fills its slots.
 * Without sync, or after "Read without a group", it is the solo reader.
 */
export function GroupReading(props: GroupReadingProps) {
  const env = useGroupEnv();
  if (env === null || env.groupsDisabled) return <ReadingScreen {...props} />;
  return <GroupReadingOn {...props} />;
}

function GroupReadingOn(props: GroupReadingProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const snapshot = useSyncSnapshot();
  const clientIndicator = useSyncIndicator();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [sheet, setSheet] = useState<SheetView | null>(null);
  const [announcement, announce] = useAnnouncer();

  const phase = derivePhase({
    enabled: true,
    connection: snapshot.connection,
    group: snapshot.group,
    joining: false,
    resuming: false,
    hasPointer: false,
    compare: null,
    acknowledged: false,
  });
  const kind = indicatorFor(phase, clientIndicator, 'following');
  const group = snapshot.group;
  const graceEndsAt =
    group?.status === 'active' && group.leader.status !== 'online'
      ? (group.leader.graceEndsAt ?? null)
      : null;

  // Announce indicator changes once each (design 5.2, AC30).
  const shownKind = useRef<IndicatorKind | null>(null);
  useEffect(() => {
    if (kind === null) return;
    const text = indicatorAnnouncement(shownKind.current, kind, i18n, {
      graceMs: graceEndsAt === null ? null : graceEndsAt - Date.now(),
      leadingAnnounced: false,
    });
    shownKind.current = kind;
    if (text !== null) announce(text);
  }, [kind, i18n, graceEndsAt, announce]);

  const content: SheetContent | null =
    sheet === 'start'
      ? startView({ canStart: true, onStart: () => undefined, onJoin: () => undefined, t })
      : null;

  return (
    <>
      <ReadingScreen
        {...props}
        announce={announcement}
        headerEndSlot={
          kind === null ? null : (
            <GroupButton
              ref={buttonRef}
              kind={kind}
              graceEndsAt={graceEndsAt}
              onOpen={() => setSheet('start')}
            />
          )
        }
      />
      {content !== null ? (
        <GroupSheet
          content={content}
          onClose={() => setSheet(null)}
          returnFocus={() => buttonRef.current}
        />
      ) : null}
    </>
  );
}
