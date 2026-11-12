import { describe, expect, it } from 'vitest';
import {
  type Banner,
  type BannerContext,
  type BannerEvent,
  type BannerState,
  INITIAL_BANNERS,
  autoHides,
  bannerText,
  bannerTone,
  banners,
} from '../src/group/banners.js';

const MEMBER: BannerContext = { isLeader: false, isVice: false, locked: false, inGroup: true };

function run(...events: BannerEvent[]): BannerState {
  return events.reduce(banners, INITIAL_BANNERS);
}
const show = (banner: Banner): BannerEvent => ({ type: 'show', banner });
const kinds = (state: BannerState) => ({
  current: state.current?.kind ?? null,
  waiting: Object.values(state.waiting).map((b) => b.kind),
});

const ENDED: Banner = { row: 1, kind: 'ended', text: 'endedByLeader' };
const LOST: Banner = { row: 3, kind: 'lost', reason: 'handoff_disconnect' };
const CHANGED: Banner = { row: 3, kind: 'changed', reason: 'take_back' };
const VICE_ON: Banner = { row: 4, kind: 'vice', on: true };
const LOCKED: Banner = { row: 5, kind: 'lock', locked: true };
const QR: Banner = { row: 6, kind: 'qr-pasted' };

describe('banner slot controller (#25 architecture 6.2, design 2.3)', () => {
  it('higher or equal priority replaces at once, the old one is discarded (rule 1)', () => {
    let state = run(show(QR), show(LOCKED));
    expect(kinds(state)).toEqual({ current: 'lock', waiting: [] });
    state = banners(state, show(CHANGED));
    expect(kinds(state)).toEqual({ current: 'changed', waiting: [] });
    state = banners(state, show({ row: 3, kind: 'changed', reason: 'superseded' }));
    expect(state.current).toMatchObject({ kind: 'changed', reason: 'superseded' });
    state = banners(state, show(ENDED));
    expect(kinds(state)).toEqual({ current: 'ended', waiting: [] });
  });

  it('lower priority waits, the latest per row, and shows when the current goes (rules 2, 3)', () => {
    let state = run(
      show(LOST),
      show(QR),
      show(LOCKED),
      show({ row: 5, kind: 'lock', locked: false }),
    );
    expect(kinds(state)).toEqual({ current: 'lost', waiting: ['lock', 'qr-pasted'] });
    expect(state.waiting[5]).toMatchObject({ locked: false });
    state = banners(state, { type: 'dismiss', id: state.current!.id });
    expect(state.current).toMatchObject({ kind: 'lock', locked: false });
    state = banners(state, { type: 'expire', id: state.current!.id });
    expect(kinds(state)).toEqual({ current: 'qr-pasted', waiting: [] });
    state = banners(state, { type: 'dismiss', id: state.current!.id });
    expect(state.current).toBeNull();
  });

  it('ignores a dismiss or expire for a banner that is not shown', () => {
    const state = run(show(LOST), show(QR));
    const waitingId = state.waiting[6]!.id;
    expect(banners(state, { type: 'expire', id: waitingId })).toBe(state);
    expect(banners(state, { type: 'dismiss', id: 999 })).toBe(state);
  });

  it('a new banner of the shown row drops an older waiting one of that row', () => {
    const state = run(show(LOST), show(VICE_ON), show({ row: 4, kind: 'vice', on: false }));
    expect(Object.keys(state.waiting)).toEqual(['4']);
  });

  it('drops banners that are no longer true (rule 4)', () => {
    let state = run(
      { type: 'context', ctx: { ...MEMBER, isVice: true, locked: true } },
      show(CHANGED),
      show(VICE_ON),
      show(LOCKED),
    );
    // the lock changed back
    state = banners(state, { type: 'context', ctx: { ...MEMBER, isVice: true, locked: false } });
    expect(kinds(state)).toEqual({ current: 'changed', waiting: ['vice'] });
    // vice changed back
    state = banners(state, { type: 'context', ctx: MEMBER });
    expect(kinds(state)).toEqual({ current: 'changed', waiting: [] });
  });

  it('drops every member notice when the user leads, current and waiting', () => {
    const state = run(show(LOST), show(VICE_ON), show(LOCKED), show(QR), {
      type: 'context',
      ctx: { ...MEMBER, isLeader: true, isVice: true, locked: true },
    });
    expect(kinds(state)).toEqual({ current: 'qr-pasted', waiting: [] });
    const cleared = run(show(CHANGED), show(QR), { type: 'clear-member-notices' });
    expect(kinds(cleared)).toEqual({ current: 'qr-pasted', waiting: [] });
  });

  it('keeps only the ended and QR notices once out of the group', () => {
    const state = run(
      { type: 'context', ctx: { ...MEMBER, locked: true } },
      show(LOCKED),
      show(QR),
      show(ENDED),
      { type: 'context', ctx: { ...MEMBER, inGroup: false } },
    );
    expect(kinds(state)).toEqual({ current: 'ended', waiting: ['qr-pasted'] });
    const notEnded = run(show(LOST), show(QR), {
      type: 'context',
      ctx: { ...MEMBER, inGroup: false },
    });
    expect(kinds(notEnded)).toEqual({ current: 'qr-pasted', waiting: [] });
  });

  it('gives each shown banner a new id', () => {
    const state = run(show(QR), show(QR));
    expect(state.current!.id).toBe(2);
  });

  it('maps every banner to its text, tone and lifetime (design 2.4, 6.9, 7.8)', () => {
    expect(bannerText(ENDED)).toBe('endedByLeader');
    expect(bannerText(LOST)).toBe('lostDisconnect');
    expect(bannerText({ row: 3, kind: 'lost', reason: 'handoff_inactivity' })).toBe('lostInactive');
    expect(bannerText({ row: 3, kind: 'lost', reason: 'take_back' })).toBe('lostTakeBack');
    expect(bannerText({ row: 3, kind: 'lost', reason: 'superseded' })).toBe('lostSuperseded');
    expect(bannerText({ row: 3, kind: 'refused' })).toBe('takeBackNotAllowed');
    expect(bannerText(CHANGED)).toBe('changedTakeBack');
    expect(bannerText({ row: 3, kind: 'changed', reason: 'handoff_disconnect' })).toBe(
      'changedDisconnect',
    );
    expect(bannerText(VICE_ON)).toBe('noticeViceOn');
    expect(bannerText({ row: 4, kind: 'vice', on: false })).toBe('noticeViceOff');
    expect(bannerText(LOCKED)).toBe('noticeLocked');
    expect(bannerText({ row: 5, kind: 'lock', locked: false })).toBe('noticeUnlocked');
    expect(bannerText(QR)).toBe('noticeQrPasted');
    expect([ENDED, LOST, { row: 3, kind: 'refused' } as Banner, QR].map(autoHides)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect([CHANGED, VICE_ON, LOCKED].map(autoHides)).toEqual([true, true, true]);
    expect(bannerTone(LOST)).toBe('warning');
    expect(bannerTone({ row: 3, kind: 'refused' })).toBe('warning');
    expect(bannerTone(CHANGED)).toBe('info');
  });
});
