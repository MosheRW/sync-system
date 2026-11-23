import type { LeadershipReason } from '@mosherw/sync-system-react';
import type { Messages } from '../i18n/en.js';

/**
 * The banner slot (#25 architecture 6.2, design 2.3, 2.4): one banner at a
 * time, by priority row; row 2 (preview) is a mode, not a queued banner.
 * Pure: the hook feeds it events; the slot renders `current`.
 */
export type BannerRow = 1 | 3 | 4 | 5 | 6;

export type Banner =
  /** The group ended, was left or removed (8a F12); `focus`: focus its Dismiss (F12.3). */
  | {
      readonly row: 1;
      readonly kind: 'ended';
      readonly text: keyof Messages;
      readonly focus?: boolean;
    }
  /** This user lost the lead (sticky, warning, AC47). */
  | {
      readonly row: 3;
      readonly kind: 'lost';
      readonly reason: LeadershipReason;
      readonly focus?: boolean;
    }
  /** The take-back was refused (sticky, warning, AC48). */
  | { readonly row: 3; readonly kind: 'refused' }
  /** Someone else leads now (info, auto-hide, AC49). */
  | { readonly row: 3; readonly kind: 'changed'; readonly reason: LeadershipReason }
  /** This member became, or is no longer, the vice-leader (info, auto-hide, AC60). */
  | { readonly row: 4; readonly kind: 'vice'; readonly on: boolean }
  /** The leader locked or unlocked the group (info, auto-hide, AC44). */
  | { readonly row: 5; readonly kind: 'lock'; readonly locked: boolean }
  /** A pasted QR link was not used (sticky, AC57, U8). */
  | { readonly row: 6; readonly kind: 'qr-pasted' };

export type ShownBanner = Banner & { readonly id: number };

export interface BannerContext {
  readonly isLeader: boolean;
  readonly isVice: boolean;
  readonly locked: boolean;
  readonly inGroup: boolean;
}

export interface BannerState {
  readonly current: ShownBanner | null;
  readonly waiting: Readonly<Partial<Record<BannerRow, ShownBanner>>>;
  readonly nextId: number;
}

export type BannerEvent =
  | { readonly type: 'show'; readonly banner: Banner }
  | { readonly type: 'dismiss'; readonly id: number }
  | { readonly type: 'expire'; readonly id: number }
  | { readonly type: 'context'; readonly ctx: BannerContext }
  /** Now leading (design 2.5): member-side notices go, shown or waiting. */
  | { readonly type: 'clear-member-notices' };

export const INITIAL_BANNERS: BannerState = Object.freeze({
  current: null,
  waiting: Object.freeze({}),
  nextId: 1,
});

/** Info notices hide by themselves after 15 s of visible time (design 2.4, U8). */
export const AUTO_HIDE_MS = 15_000;

/** True for the info notices that hide by themselves (leader-changed, vice, lock). */
export function autoHides(banner: Banner): boolean {
  return banner.kind === 'changed' || banner.kind === 'vice' || banner.kind === 'lock';
}

/** Lost-lead and take-back refused use the warning tone (design 6.9). */
export function bannerTone(banner: Banner): 'info' | 'warning' {
  return banner.kind === 'lost' || banner.kind === 'refused' ? 'warning' : 'info';
}

const LOST: Record<LeadershipReason, keyof Messages> = {
  handoff_disconnect: 'lostDisconnect',
  handoff_inactivity: 'lostInactive',
  take_back: 'lostTakeBack',
  superseded: 'lostSuperseded',
};

const CHANGED: Record<LeadershipReason, keyof Messages> = {
  handoff_disconnect: 'changedDisconnect',
  handoff_inactivity: 'changedInactive',
  take_back: 'changedTakeBack',
  superseded: 'changedSuperseded',
};

/** The banner's text (design 7.8, 7.9); never a name, a code or a position. */
export function bannerText(banner: Banner): keyof Messages {
  switch (banner.kind) {
    case 'ended':
      return banner.text;
    case 'lost':
      return LOST[banner.reason];
    case 'refused':
      return 'takeBackNotAllowed';
    case 'changed':
      return CHANGED[banner.reason];
    case 'vice':
      return banner.on ? 'noticeViceOn' : 'noticeViceOff';
    case 'lock':
      return banner.locked ? 'noticeLocked' : 'noticeUnlocked';
    case 'qr-pasted':
      return 'noticeQrPasted';
  }
}

/** Still true in this context (design 2.3 rule 3). */
function stillTrue(banner: Banner, ctx: BannerContext): boolean {
  if (!ctx.inGroup) return banner.kind === 'ended' || banner.kind === 'qr-pasted';
  if (banner.row >= 3 && banner.row <= 5 && ctx.isLeader) return false;
  if (banner.kind === 'lock') return banner.locked === ctx.locked;
  if (banner.kind === 'vice') return banner.on === ctx.isVice;
  return true;
}

/** The highest waiting banner becomes current (rule 3). */
function promote(state: BannerState): BannerState {
  if (state.current !== null) return state;
  const rows = (Object.keys(state.waiting).map(Number) as BannerRow[]).sort((a, b) => a - b);
  const top = rows[0];
  if (top === undefined) return state;
  const waiting = { ...state.waiting };
  const current = waiting[top]!;
  delete waiting[top];
  return { ...state, current, waiting };
}

function keep(state: BannerState, test: (banner: ShownBanner) => boolean): BannerState {
  const current = state.current !== null && test(state.current) ? state.current : null;
  const waiting: Partial<Record<BannerRow, ShownBanner>> = {};
  for (const [row, banner] of Object.entries(state.waiting)) {
    if (banner !== undefined && test(banner)) waiting[Number(row) as BannerRow] = banner;
  }
  const same =
    current === state.current && Object.keys(waiting).length === Object.keys(state.waiting).length;
  return same ? state : promote({ ...state, current, waiting });
}

export function banners(state: BannerState, event: BannerEvent): BannerState {
  switch (event.type) {
    case 'show': {
      const shown = { ...event.banner, id: state.nextId } as ShownBanner;
      const nextId = state.nextId + 1;
      // Rule 1: higher or equal priority replaces at once; the old one goes.
      if (state.current === null || shown.row <= state.current.row) {
        const waiting = { ...state.waiting };
        // A waiting banner of the same row is older news on the same subject.
        delete waiting[shown.row];
        return { current: shown, waiting, nextId };
      }
      // Rule 2: lower priority waits, the latest per row.
      return { ...state, waiting: { ...state.waiting, [shown.row]: shown }, nextId };
    }
    case 'dismiss':
    case 'expire':
      if (state.current?.id !== event.id) return state;
      return promote({ ...state, current: null });
    case 'context':
      return keep(state, (banner) => stillTrue(banner, event.ctx));
    case 'clear-member-notices':
      return keep(state, (banner) => banner.row < 3 || banner.row > 5);
  }
}
