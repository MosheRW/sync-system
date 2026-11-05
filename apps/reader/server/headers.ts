import { checkAllowedOrigin } from '../src/content/origin.js';

/**
 * The production CSP (ADR 0006, security C7): no inline script or style, no
 * eval, no data:/blob:. `connect-src` is `'self'` plus the configured `?src`
 * origins, each re-checked and re-serialised here so a malformed entry can
 * never add a directive (security C2).
 */
export function contentSecurityPolicy(srcOrigins: readonly string[]): string {
  const origins: string[] = [];
  for (const entry of srcOrigins) {
    const checked = checkAllowedOrigin(entry);
    if (!checked.ok) throw new Error('refusing to put a non-canonical origin into the CSP');
    origins.push(checked.origin);
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
export function securityHeaders(srcOrigins: readonly string[]): Readonly<Record<string, string>> {
  return Object.freeze({
    'Content-Security-Policy': contentSecurityPolicy(srcOrigins),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
}
