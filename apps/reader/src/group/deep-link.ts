import { isQrTicketShape } from '@sync-system/react';
import { isContentId } from '../content/content-id.js';
import { checkSrc } from '../content/src-policy.js';

/**
 * QR deep links (#24 AC12, AC17, security R3, R4). The ticket is a bearer
 * credential: it travels only in the URL fragment (`#t=<ticket>`, never the
 * query string, #10 AC43), is removed from the address bar and the session
 * history before anything else runs, and then lives in memory only. It is
 * never stored, logged, announced or put into another URL.
 */

const TICKET_PREFIX = '#t=';

/** What a page load found in the fragment. */
export type QrLanding = { kind: 'ticket'; ticket: string } | { kind: 'invalid' };

export interface LocationParts {
  readonly hash: string;
  readonly pathname: string;
  readonly search: string;
}

export interface HistoryLike {
  readonly state: unknown;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

/**
 * Takes a `#t=` fragment and replaces the current history entry with the
 * same URL without it, whether the ticket is well-formed or not and whether
 * sync is on or off (design F5.3). Other fragments are left alone.
 */
export function takeQrTicket(location: LocationParts, history: HistoryLike): QrLanding | null {
  if (!location.hash.startsWith(TICKET_PREFIX)) return null;
  const value = location.hash.slice(TICKET_PREFIX.length);
  history.replaceState(history.state, '', location.pathname + location.search);
  return isQrTicketShape(value) ? { kind: 'ticket', ticket: value } : { kind: 'invalid' };
}

export interface WindowLike {
  readonly location: LocationParts;
  readonly history: HistoryLike;
  addEventListener(type: 'hashchange', listener: () => void): void;
  removeEventListener(type: 'hashchange', listener: () => void): void;
}

/**
 * A `#t=` link pasted into a tab that is already open changes only the
 * fragment (`hashchange`, no reload): strip it the same way and drop the
 * ticket (L2). Joining always starts from a page load. Then, only for a
 * stripped `#t=`, `onIgnored()` is called with **no arguments** (#25 AC57,
 * R20): the ticket never leaves this function; a throwing listener can't
 * undo the strip.
 */
export function stripLaterTickets(win: WindowLike, onIgnored?: () => void): () => void {
  const onChange = () => {
    if (takeQrTicket(win.location, win.history) === null) return;
    try {
      onIgnored?.();
    } catch {
      // The notice is best effort; the strip already happened.
    }
  };
  win.addEventListener('hashchange', onChange);
  return () => win.removeEventListener('hashchange', onChange);
}

/** The book the leader's QR code opens, from validated values only (R4). */
export type ShareTarget =
  | { kind: 'single-book' }
  | { kind: 'book'; contentId: string }
  | { kind: 'src'; url: string; srcOrigins: readonly string[] };

/**
 * `<origin>/?book=<id>#t=<ticket>`, `<origin>/?src=<href>#t=<ticket>` or, in
 * single-book mode, `<origin>/#t=<ticket>` (architecture 9.2). The content
 * ID must be a content ID, the `?src` URL passes the allow-list again and
 * is used as its parsed `href`. `null` when either check fails or the ticket
 * has the wrong shape.
 */
export function buildJoinLink(origin: string, target: ShareTarget, ticket: string): string | null {
  if (!isQrTicketShape(ticket)) return null;
  let base: URL;
  try {
    base = new URL('/', origin);
  } catch {
    return null;
  }
  let query = '';
  if (target.kind === 'book') {
    if (!isContentId(target.contentId)) return null;
    query = `?book=${encodeURIComponent(target.contentId)}`;
  } else if (target.kind === 'src') {
    const checked = checkSrc(target.url, target.srcOrigins);
    if (!checked.ok) return null;
    query = `?src=${encodeURIComponent(checked.url.href)}`;
  }
  return `${base.origin}/${query}${TICKET_PREFIX}${ticket}`;
}
