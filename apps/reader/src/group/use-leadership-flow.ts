import { useSyncEvent } from '@sync-system/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Banner } from './banners.js';

export interface LeadershipFlowOptions {
  /** A member of an active group (the snapshot role). */
  readonly isMember: boolean;
  /** This member is the vice-leader (`useViceLeader().isVice`). */
  readonly isVice: boolean;
  /** Shows a banner in the slot (`useBannerSlot().show`). */
  readonly show: (banner: Banner) => void;
}

export interface LeadershipFlow {
  /**
   * The "last chance" hint (#25 architecture 8.3, D2b): this tab leads
   * because of a missed keep-alive and has sent no leader activity since,
   * so the next run-out ends the group.
   */
  readonly lastChance: boolean;
  /** This tab sent a leader activity (a move, a preview turn, a leader action, an answer). */
  readonly leaderActivity: () => void;
}

/**
 * Leadership flows on the reading page (#25 architecture 8).
 *
 * Member notices (8.6, AC44, AC60): the vice-leader notice when this member
 * becomes, or stops being, the vice-leader while still a member, and the
 * lock notice on each `lockChanged` while a member. Joining a group that is
 * already locked shows no banner (the state didn't change while in it).
 *
 * The last-chance hint (8.3): set on `nowLeading` for `handoff_inactivity`,
 * cleared by this tab's leader activity and by any other leadership change.
 */
export function useLeadershipFlow({
  isMember,
  isVice,
  show,
}: LeadershipFlowOptions): LeadershipFlow {
  const member = useRef(isMember);
  member.current = isMember;

  const wasVice = useRef(isVice);
  useEffect(() => {
    if (wasVice.current === isVice) return;
    wasVice.current = isVice;
    // Not "no longer vice" when the clear is because they became leader (AC60).
    if (member.current) show({ row: 4, kind: 'vice', on: isVice });
  }, [isVice, show]);

  useSyncEvent('lockChanged', (event) => {
    if (member.current) show({ row: 5, kind: 'lock', locked: event.locked });
  });

  const [lastChance, setLastChance] = useState(false);
  useSyncEvent('nowLeading', (event) => setLastChance(event.reason === 'handoff_inactivity'));
  useSyncEvent('leadershipLost', () => setLastChance(false));
  const leaderActivity = useCallback(() => setLastChance(false), []);

  return { lastChance, leaderActivity };
}
