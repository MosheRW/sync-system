import { describe, expect, it } from 'vitest';
import { isSyncClientError } from '../src/errors.js';
import { resolveOptions } from '../src/options.js';
import { checkServerUrl } from '../src/url-policy.js';

function rejected(url: string, allowInsecureTransport = false): boolean {
  try {
    checkServerUrl(url, allowInsecureTransport);
    return false;
  } catch (err) {
    return isSyncClientError(err, 'INVALID_OPTIONS') && err.details.field === 'url';
  }
}

describe('checkServerUrl (M2, Q-B)', () => {
  it.each([
    'ws://localhost.attacker.example',
    'ws://127.0.0.1.nip.io',
    'ws://user@localhost@host',
    'ws://user:pw@localhost',
    'wss://user@example.com',
    'wss://host/#x',
    'wss://host/#',
    'https://host',
    'http://localhost',
    'ftp://x',
    'ws://example.com',
    'ws://127.0.0.2',
    'not a url',
    '',
  ])('rejects %s', (url) => {
    expect(rejected(url)).toBe(true);
  });

  it.each([
    ['wss://example.com', 'wss://example.com/'],
    ['WS://LOCALHOST', 'ws://localhost/'],
    ['ws://127.0.0.1:8080/ws', 'ws://127.0.0.1:8080/ws'],
    ['ws://[::1]:8080', 'ws://[::1]:8080/'],
    ['wss://example.com/ws?x=1', 'wss://example.com/ws?x=1'],
  ])('accepts %s and returns the parsed href (R2-L3)', (url, href) => {
    expect(checkServerUrl(url, false)).toBe(href);
  });

  it('accepts non-loopback ws:// only with allowInsecureTransport true', () => {
    expect(checkServerUrl('ws://example.com', true)).toBe('ws://example.com/');
    expect(rejected('https://example.com', true)).toBe(true);
    expect(rejected('ws://user@example.com', true)).toBe(true);
  });
});

describe('url in options', () => {
  const base = { apiKey: 'k'.repeat(40), appVersion: '1.0.0' };

  it('stores the checked href', () => {
    expect(resolveOptions({ ...base, url: 'WSS://Example.com' }).url).toBe('wss://example.com/');
  });

  it('rejects an insecure url unless the opt-out is exactly true', () => {
    expect(() => resolveOptions({ ...base, url: 'ws://example.com' })).toThrow();
    expect(() =>
      resolveOptions({ ...base, url: 'ws://example.com', allowInsecureTransport: 'true' }),
    ).toThrow();
    expect(
      resolveOptions({ ...base, url: 'ws://example.com', allowInsecureTransport: true }).url,
    ).toBe('ws://example.com/');
  });
});
