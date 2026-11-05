import type { ContentError } from './errors.js';
import { LOOPBACK_HOSTS } from './origin.js';
import { truncate } from './quote.js';

export type SrcCheck = { ok: true; url: URL } | { ok: false; error: ContentError };

/**
 * Decides whether a `?src` value may be fetched (ADR 0006, security C2).
 * Parsed with WHATWG `URL` and **no base** (relative values are invalid);
 * `http:`/`https:` only (`http:` only for loopback); no credentials; the
 * origin must equal an allow-list entry exactly. An empty list disables
 * `?src`. Callers fetch `url.href`, never the raw string.
 */
export function checkSrc(raw: string, origins: readonly string[]): SrcCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: { kind: 'src-invalid' } };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: { kind: 'src-invalid' } };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: { kind: 'src-invalid' } };
  }
  const notAllowed: SrcCheck = {
    ok: false,
    error: { kind: 'src-not-allowed', origin: truncate(url.origin) },
  };
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname)) return notAllowed;
  if (!origins.includes(url.origin)) return notAllowed;
  return { ok: true, url };
}
