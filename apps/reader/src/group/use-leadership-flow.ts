import {
  type LeadershipReason,
  type NowLeadingEvent,
  useLeadership,
  useSyncEvent,
} from '@mosherw/sync-system-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Banner } from './banners.js';

/** The now-leading dialog's content (#25 architecture 8.1). */
export interface NowLeading {
  readonly reason: NowLeadingEvent['reason'];
  /** This tab's page is not the group's: both pages, and preview on dismiss (U7). */
  readonly offPage: { readonly ownIndex: number; readonly groupIndex: number } | null;
  /** The last member-side content check failed or wasn't acknowledged (U11, D9). */
  readonly mismatch: boolean;
}

export interface LeadershipFlowOptions {
  /** The active group's ID, or `null`. */
  readonly groupId: string | null;
  /** Leads the active group (the snapshot role). */
  readonly isLeader: boolean;
  /** A member of an active group (the snapshot role). */
  readonly isMember: boolean;
  /** This member is the vice-leader (`useViceLeader().isVice`). */
  readonly isVice: boolean;
  /** Shows a banner in the slot (`useBannerSlot().show`). */
  readonly show: (banner: Banner) => void;
  /** Now leading: member-side notices go (design 2.5). */
  readonly clearMemberNotices: () => void;
  /** This tab's page and the group's (decoded), when the lead arrives. */
  readonly pages: () => { readonly ownIndex: number; readonly groupIndex: number | null };
  /** The last member-side content check was a mismatch (8.4). */
  readonly mismatch: () => boolean;
  /** Called on `nowLeading` before the next render (the 8a announcement is skipped, 8.1 step 3). */
  readonly onNowLeading: (groupId: string) => void;
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
  /** The now-leading dialog, or `null`. */
  readonly nowLeading: NowLeading | null;
  readonly dismissNowLeading: () => void;
  /** Show the take-back card (8.5, R17). */
  readonly takeBackCard: boolean;
  /** Keep following: not asked again for this offer. */
  readonly declineTakeBack: () => void;
  /** The server refused the take-back: sticky banner (F21.5). */
  readonly takeBackRefused: () => void;
  /** Read once by the follow hook: this tab led `groupId` and lost the lead (8.2). */
  readonly consumeDemoted: (groupId: string) => boolean;
}

/** Focus was inside a part that closes with the lead (design 2.5, F12.3). */
function focusInLeaderPart(): boolean {
  return document.activeElement?.closest('dialog, aside, [role="region"]') != null;
}

/**
 * Leadership flows on the reading page (#25 architecture 8): now leading,
 * lost lead (also while away, Q-A1), take-back, leader changed, and the
 * member's vice and lock notices. The leader-only UI itself follows the
 * snapshot role (R16); this hook holds only reader-local, in-memory state.
 */
export function useLeadershipFlow(options: LeadershipFlowOptions): LeadershipFlow {
  const { groupId, isLeader, isMember, isVice, show } = options;
  const opts = useRef(options);
  opts.current = options;
  const member = useRef(isMember);
  member.current = isMember;
  const leadership = useLeadership();

  // ---- member notices (8.6, AC44, AC60) ----
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

  useSyncEvent('leaderChanged', (event) => {
    // A displaced leader gets leadershipLost instead (F23.3); never a name.
    if (member.current) show({ row: 3, kind: 'changed', reason: event.reason });
  });

  // ---- roles this tab held (memory only, R16) ----
  const led = useRef(new Set<string>());
  useEffect(() => {
    if (isLeader && groupId !== null) led.current.add(groupId);
  }, [isLeader, groupId]);
  const demoted = useRef(new Set<string>());
  const consumeDemoted = useCallback((id: string) => demoted.current.delete(id), []);

  // ---- take-back (8.5) ----
  const [declined, setDeclined] = useState(false);
  const [lastLoss, setLastLoss] = useState<LeadershipReason | null>(null);
  const [lastChance, setLastChance] = useState(false);

  const lost = (id: string, reason: LeadershipReason) => {
    led.current.delete(id);
    demoted.current.add(id);
    setLastLoss(reason);
    setDeclined(false);
    setLastChance(false);
    setNowLeading(null);
    show({ row: 3, kind: 'lost', reason, focus: focusInLeaderPart() });
  };

  useSyncEvent('leadershipLost', (event) => lost(event.groupId, event.reason));

  // Lost while away (Q-A1): back as a member with no leadershipLost.
  useSyncEvent('rejoined', (event) => {
    if (event.role === 'member' && led.current.has(event.groupId)) {
      lost(event.groupId, 'handoff_disconnect');
    }
  });

  // ---- now leading (8.1) ----
  const [nowLeading, setNowLeading] = useState<NowLeading | null>(null);
  useSyncEvent('nowLeading', (event) => {
    const o = opts.current;
    o.onNowLeading(event.groupId);
    o.clearMemberNotices();
    setLastChance(event.reason === 'handoff_inactivity');
    setLastLoss(null);
    setNowLeading((open) => {
      // A second one while open replaces the reason in place.
      if (open !== null) return { ...open, reason: event.reason };
      const { ownIndex, groupIndex } = o.pages();
      return {
        reason: event.reason,
        offPage: groupIndex !== null && groupIndex !== ownIndex ? { ownIndex, groupIndex } : null,
        mismatch: o.mismatch(),
      };
    });
  });
  const dismissNowLeading = useCallback(() => setNowLeading(null), []);

  // Every new group starts clean (a reconnect to the same group keeps it).
  const lastGroup = useRef(groupId);
  useEffect(() => {
    if (groupId === null || groupId === lastGroup.current) return;
    lastGroup.current = groupId;
    setDeclined(false);
    setLastLoss(null);
  }, [groupId]);

  const leaderActivity = useCallback(() => setLastChance(false), []);
  const declineTakeBack = useCallback(() => setDeclined(true), []);
  const takeBackRefused = useCallback(() => show({ row: 3, kind: 'refused' }), [show]);

  return {
    lastChance: isLeader && lastChance,
    leaderActivity,
    nowLeading: isLeader ? nowLeading : null,
    dismissNowLeading,
    // Server-driven offer, with the reader's own suppression only (R17).
    // Q-A2: no card after a `take_back` loss, so the lead doesn't pass back
    // and forth; the server refuses that take-back too (#32).
    takeBackCard: isMember && leadership.takeBackAvailable && !declined && lastLoss !== 'take_back',
    declineTakeBack,
    takeBackRefused,
    consumeDemoted,
  };
}
