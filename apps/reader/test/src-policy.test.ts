import { describe, expect, it } from 'vitest';
import { checkAllowedOrigin, isLoopbackHttpOrigin } from '../src/content/origin.js';
import { checkSrc } from '../src/content/src-policy.js';

const ORIGINS = ['https://content.example.org', 'http://localhost:4000'];

function errorOf(raw: string, origins: readonly string[] = ORIGINS) {
  const result = checkSrc(raw, origins);
  return result.ok ? null : result.error;
}

describe('checkSrc (ADR 0006, security C2)', () => {
  it('allows an exact origin match and returns the parsed URL', () => {
    const result = checkSrc('https://content.example.org/books/a.json?v=1', ORIGINS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.href).toBe('https://content.example.org/books/a.json?v=1');
  });

  it('allows http only for a listed loopback origin', () => {
    expect(checkSrc('http://localhost:4000/a.json', ORIGINS).ok).toBe(true);
    expect(errorOf('http://localhost:4001/a.json')).toMatchObject({ kind: 'src-not-allowed' });
    expect(errorOf('http://content.example.org/a.json', ['http://content.example.org'])).toEqual({
      kind: 'src-not-allowed',
      origin: 'http://content.example.org',
    });
  });

  it('is disabled by an empty list', () => {
    expect(errorOf('https://content.example.org/a.json', [])).toEqual({
      kind: 'src-not-allowed',
      origin: 'https://content.example.org',
    });
  });

  it('normalises default ports and case before comparing', () => {
    expect(checkSrc('https://CONTENT.example.org:443/a.json', ORIGINS).ok).toBe(true);
    expect(errorOf('https://content.example.org:8443/a.json')).toMatchObject({
      kind: 'src-not-allowed',
    });
  });

  it.each([
    ['prefix host', 'https://content.example.org.evil.net/a.json'],
    ['suffix host', 'https://evilcontent.example.org/a.json'],
    ['subdomain', 'https://x.content.example.org/a.json'],
    ['http downgrade', 'http://content.example.org/a.json'],
    ['IDN look-alike', 'https://cоntent.example.org/a.json'],
  ])('refuses a %s', (_name, raw) => {
    expect(errorOf(raw)).toMatchObject({ kind: 'src-not-allowed' });
  });

  it.each([
    ['relative path', '/books/a.json'],
    ['protocol-relative', '//content.example.org/a.json'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:application/json,{}'],
    ['blob:', 'blob:https://content.example.org/1234'],
    ['file:', 'file:///etc/passwd'],
    ['userinfo', 'https://content.example.org@evil.net/a.json'],
    ['credentials on the allowed host', 'https://user:pass@content.example.org/a.json'],
    ['garbage', 'not a url'],
    ['empty', ''],
  ])('refuses %s as invalid', (_name, raw) => {
    expect(errorOf(raw)).toEqual({ kind: 'src-invalid' });
  });

  it('keeps backslash tricks on the parsed host', () => {
    // WHATWG URL turns "\" into "/" for http(s): the host stays content.example.org.
    const result = checkSrc('https://content.example.org\\@evil.net/a.json', ORIGINS);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.url.origin).toBe('https://content.example.org');
    expect(errorOf('https://evil.net\\@content.example.org/a.json')).toMatchObject({
      kind: 'src-not-allowed',
    });
  });

  it('truncates the origin shown in details to 40 characters', () => {
    const error = errorOf(`https://${'a'.repeat(60)}.example/a.json`);
    expect(error).toMatchObject({ kind: 'src-not-allowed' });
    if (error?.kind === 'src-not-allowed') expect(Array.from(error.origin)).toHaveLength(41);
  });
});

describe('checkAllowedOrigin (config entries, security C2)', () => {
  it.each([
    'https://a.example',
    'https://a.example:8443',
    'http://localhost:3000',
    'http://127.0.0.1:8000',
  ])('accepts %s', (entry) => {
    expect(checkAllowedOrigin(entry)).toEqual({ ok: true, origin: entry });
  });

  it.each([
    ['https://a.example/', 'not-canonical'],
    ['https://a.example/path', 'not-canonical'],
    ['https://a.example?q', 'not-canonical'],
    ['https://a.example#f', 'not-canonical'],
    ['https://A.example', 'not-canonical'],
    ['https://a.example:443', 'not-canonical'],
    ['https://*.example', 'wildcard'],
    ['https://*', 'wildcard'],
    ['https://a.example; script-src *', 'not-a-url'],
    ['a.example', 'not-a-url'],
    ['*', 'not-a-url'],
    ['ftp://a.example', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['http://a.example', 'http-not-loopback'],
    ['https://u:p@a.example', 'credentials'],
    // #24 L1, R1: hosts a CSP source can't hold; IPv6 literals aren't CSP host sources.
    ['https://a;b', 'host'],
    ['https://a,b', 'host'],
    ["https://a'b", 'host'],
    ['http://[::1]:5000', 'host'],
  ])('rejects %j (%s)', (entry, issue) => {
    expect(checkAllowedOrigin(entry)).toEqual({ ok: false, issue });
  });

  it('detects loopback http origins', () => {
    expect(isLoopbackHttpOrigin('http://localhost:3000')).toBe(true);
    expect(isLoopbackHttpOrigin('https://localhost:3000')).toBe(false);
  });
});
