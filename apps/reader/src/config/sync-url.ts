import { isCspHostname } from '../content/origin.js';

/**
 * The sync server URL rule (#24 AC1, security R1). Pure: only the WHATWG
 * `URL` global, so the config parser (Node), the CSP builder (Node) and the
 * browser's config check share it.
 */

/** Hosts for which `ws:` is allowed (development only). */
export const SYNC_LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

export type SyncUrlIssue =
  'not-a-url' | 'scheme' | 'ws-not-loopback' | 'credentials' | 'query' | 'fragment' | 'host';

export type SyncUrlCheck =
  | { ok: true; href: string; origin: string; loopbackWs: boolean }
  | { ok: false; issue: SyncUrlIssue };

/**
 * Checks `READER_SYNC_URL`: parsed without a base; `wss:`, or `ws:` only for
 * `localhost` and `127.0.0.1`; no user name, password, query or fragment; a
 * host that is safe as a CSP source (no `*`, `;`, `,`, quotes or IPv6
 * literals). A path is allowed (the sync server listens on `/ws`). Returns
 * the parsed `href` (what the client connects to) and `origin` (the only
 * form that ever reaches the CSP).
 */
export function checkSyncUrl(value: string): SyncUrlCheck {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, issue: 'not-a-url' };
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') return { ok: false, issue: 'scheme' };
  if (url.username !== '' || url.password !== '') return { ok: false, issue: 'credentials' };
  // An empty "?" or "#" leaves search/hash empty but still shows in href.
  if (url.search !== '' || url.href.includes('?')) return { ok: false, issue: 'query' };
  if (url.hash !== '' || url.href.includes('#')) return { ok: false, issue: 'fragment' };
  if (!isCspHostname(url.hostname)) return { ok: false, issue: 'host' };
  const loopbackWs = url.protocol === 'ws:';
  if (loopbackWs && !SYNC_LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, issue: 'ws-not-loopback' };
  }
  return { ok: true, href: url.href, origin: url.origin, loopbackWs };
}

/** The CSP source for a sync URL already stored as a checked `href`, or `null`. */
export function syncOriginOf(href: string): string | null {
  const checked = checkSyncUrl(href);
  return checked.ok && checked.href === href ? checked.origin : null;
}
