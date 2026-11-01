import { SyncClientError } from './errors.js';
import { type UrlLike, parseUrl } from './host.js';

/** Hostnames that may use `ws://` without the opt-out, exactly as WHATWG `URL` reports them. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

function invalidUrl(): SyncClientError<'INVALID_OPTIONS'> {
  return new SyncClientError('INVALID_OPTIONS', { details: { field: 'url' } });
}

/**
 * Checks the server URL (M2, Q-B) and returns the parsed `href`, which is the
 * exact string the client connects to (R2-L3):
 * - parsed with WHATWG `URL`; a parse failure is rejected;
 * - only `wss:` and `ws:` (WebSocket also accepts `http(s):`, which is refused);
 * - `ws:` only for the exact hostnames `localhost`, `127.0.0.1` and `[::1]`,
 *   or when `allowInsecureTransport` is exactly `true`. No prefix or
 *   substring checks and no DNS;
 * - no username, password or fragment.
 */
export function checkServerUrl(url: string, allowInsecureTransport: boolean): string {
  let parsed: UrlLike;
  try {
    parsed = parseUrl(url);
  } catch {
    throw invalidUrl();
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') throw invalidUrl();
  if (parsed.username !== '' || parsed.password !== '') throw invalidUrl();
  if (parsed.hash !== '' || parsed.href.includes('#')) throw invalidUrl();
  if (
    parsed.protocol === 'ws:' &&
    allowInsecureTransport !== true &&
    !LOOPBACK_HOSTNAMES.has(parsed.hostname)
  ) {
    throw invalidUrl();
  }
  return parsed.href;
}
