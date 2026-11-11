import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useI18n } from '../i18n/index.js';
import {
  type Banner,
  type BannerContext,
  INITIAL_BANNERS,
  type ShownBanner,
  bannerText,
  banners,
} from './banners.js';

export interface BannerSlot {
  /** The banner to show (before the preview rule, architecture 6.2 rule 5). */
  readonly shown: ShownBanner | null;
  readonly show: (banner: Banner) => void;
  readonly dismiss: (id: number) => void;
  readonly expire: (id: number) => void;
  /** Now leading: member-side notices go (design 2.5). */
  readonly clearMemberNotices: () => void;
}

/**
 * The reading page's banner slot (#25 architecture 6.2): the pure
 * controller in a reducer, fed the context on every change so banners that
 * are no longer true are dropped. Each shown banner is announced once
 * (polite), except the ended notice, which the ended flow announces.
 */
export function useBannerSlot(ctx: BannerContext, announce: (text: string) => void): BannerSlot {
  const { t } = useI18n();
  const [state, dispatch] = useReducer(banners, INITIAL_BANNERS);
  const { isLeader, isVice, locked, inGroup } = ctx;
  useEffect(() => {
    dispatch({ type: 'context', ctx: { isLeader, isVice, locked, inGroup } });
  }, [isLeader, isVice, locked, inGroup]);

  // Announce a banner when it shows, once per banner (a waiting one when it comes up).
  const announced = useRef(0);
  const current = state.current;
  useEffect(() => {
    if (current === null || current.id <= announced.current) return;
    announced.current = current.id;
    if (current.kind !== 'ended') announce(t[bannerText(current)]);
  }, [current, announce, t]);

  const show = useCallback((banner: Banner) => dispatch({ type: 'show', banner }), []);
  const dismiss = useCallback((id: number) => dispatch({ type: 'dismiss', id }), []);
  const expire = useCallback((id: number) => dispatch({ type: 'expire', id }), []);
  const clearMemberNotices = useCallback(() => dispatch({ type: 'clear-member-notices' }), []);
  return useMemo(
    () => ({ shown: current, show, dismiss, expire, clearMemberNotices }),
    [current, show, dismiss, expire, clearMemberNotices],
  );
}
