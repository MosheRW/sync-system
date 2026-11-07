import { syncOriginOf } from '../src/config/sync-url.js';
import { checkAllowedOrigin } from '../src/content/origin.js';

/** What `connect-src` allows besides `'self'`. */
export interface ConnectSources {
  /** The configured `?src` origins (ADR 0006). */
  srcOrigins: readonly string[];
  /** The checked `READER_SYNC_URL` (#24 AC1), or `null` when sync is off. */
  syncUrl?: string | null;
}

/**
 * The production CSP (ADR 0006, security C7): no inline script or style, no
 * eval, no data:/blob:. `connect-src` is `'self'`, the configured `?src`
 * origins and, with sync on, the sync server's origin (#24 R1: the browser
 * opens a WebSocket to it, a different origin). Every source is re-checked
 * and re-serialised here, so a malformed value can never add a directive
 * (security C2, #24 L1). Nothing else differs when sync is on.
 */
export function contentSecurityPolicy({ srcOrigins, syncUrl = null }: ConnectSources): string {
  const origins: string[] = [];
  for (const entry of srcOrigins) {
    const checked = checkAllowedOrigin(entry);
    if (!checked.ok) throw new Error('refusing to put a non-canonical origin into the CSP');
    origins.push(checked.origin);
  }
  if (syncUrl !== null) {
    const origin = syncOriginOf(syncUrl);
    if (origin === null) throw new Error('refusing to put an unchecked sync URL into the CSP');
    if (!origins.includes(origin)) origins.push(origin);
  }
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    ["connect-src 'self'", ...origins].join(' '),
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

/** Headers sent on every response, whatever its status (security C1). */
export function securityHeaders(sources: ConnectSources): Readonly<Record<string, string>> {
  return Object.freeze({
    'Content-Security-Policy': contentSecurityPolicy(sources),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // Unchanged by #24: the QR is scanned with the phone's own camera app (Q2).
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
}
