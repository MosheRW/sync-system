/**
 * Origin rules shared by the config parser (server, startup) and the `?src`
 * policy (browser) (ADR 0006, security C2). Pure: uses only the WHATWG `URL`
 * global, available in browsers and Node.
 */

/** Hosts for which `http:` is allowed (development only, security F9). */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export type OriginIssue =
  'not-a-url' | 'scheme' | 'http-not-loopback' | 'credentials' | 'wildcard' | 'not-canonical';

export type OriginCheck = { ok: true; origin: string } | { ok: false; issue: OriginIssue };

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Checks one allow-list entry. It must be a canonical origin, exactly as
 * `URL.origin` serialises it: `https://host[:port]` (or `http:` for a
 * loopback host), no trailing slash, path, query, fragment, credentials,
 * wildcard or default port. The returned origin is the re-serialised value,
 * the only form ever written into the CSP or the page.
 */
export function checkAllowedOrigin(entry: string): OriginCheck {
  const url = parseUrl(entry);
  if (!url) return { ok: false, issue: 'not-a-url' };
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, issue: 'scheme' };
  if (url.username !== '' || url.password !== '') return { ok: false, issue: 'credentials' };
  // WHATWG URL accepts "*" in a host; in a CSP source it is a wildcard.
  if (url.hostname.includes('*')) return { ok: false, issue: 'wildcard' };
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    return { ok: false, issue: 'http-not-loopback' };
  }
  if (url.origin === 'null' || entry !== url.origin) return { ok: false, issue: 'not-canonical' };
  return { ok: true, origin: url.origin };
}

/** True for an `http:` loopback origin (used for the production warning, F9). */
export function isLoopbackHttpOrigin(origin: string): boolean {
  const url = parseUrl(origin);
  return url !== null && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}
