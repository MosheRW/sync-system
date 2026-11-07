import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildJoinLink, stripLaterTickets, takeQrTicket } from '../src/group/deep-link.js';

/** A ticket of the protocol's shape: payload, dot, 43-character signature. */
export const TICKET = `eyJnIjoxfQ.${'s'.repeat(43)}`;

afterEach(() => {
  history.replaceState(null, '', '/');
});

describe('QR ticket intake (#24 AC17, R3)', () => {
  it('takes a well-formed ticket and removes the fragment from the current entry', () => {
    history.replaceState({ keep: 1 }, '', `/?book=samples%2Fpsalms-he#t=${TICKET}`);
    const lengthBefore = history.length;
    expect(takeQrTicket(window.location, window.history)).toEqual({
      kind: 'ticket',
      ticket: TICKET,
    });
    expect(location.hash).toBe('');
    expect(location.href).not.toContain(TICKET);
    expect(location.search).toBe('?book=samples%2Fpsalms-he');
    expect(history.state).toEqual({ keep: 1 });
    // Replaced, not pushed: no history entry keeps the ticket.
    expect(history.length).toBe(lengthBefore);
  });

  it.each([
    ['empty', '#t='],
    ['wrong shape', '#t=not-a-ticket'],
    ['too long', `#t=${'a'.repeat(300)}.${'s'.repeat(43)}`],
    ['with markup', '#t=<script>alert(1)</script>'],
  ])('strips a %s ticket too and reports it as invalid', (_name, hash) => {
    history.replaceState(null, '', `/${hash}`);
    expect(takeQrTicket(window.location, window.history)).toEqual({ kind: 'invalid' });
    expect(location.hash).toBe('');
  });

  it('leaves other fragments alone', () => {
    history.replaceState(null, '', '/#chapter-2');
    expect(takeQrTicket(window.location, window.history)).toBeNull();
    expect(location.hash).toBe('#chapter-2');
  });

  it('strips a ticket pasted later into the open tab (hashchange, L2)', () => {
    const stop = stripLaterTickets(window);
    history.replaceState(null, '', `/?book=x#t=${TICKET}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(location.hash).toBe('');
    expect(location.search).toBe('?book=x');
    stop();
  });

  it('runs first in main.tsx, before the config, the book or React', () => {
    const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.tsx'), 'utf8');
    const body = main.slice(main.lastIndexOf('\nimport '));
    const statements = body
      .split('\n')
      .slice(1)
      .filter(
        (line) =>
          line.trim() !== '' && !line.trim().startsWith('//') && !line.startsWith("import '"),
      );
    expect(statements[0]).toBe('const qrLanding = takeQrTicket(window.location, window.history);');
  });
});

describe('buildJoinLink (#24 AC12, R4)', () => {
  const origin = 'https://reader.example.org';

  it('links a bundled book with the ticket only in the fragment', () => {
    const link = buildJoinLink(origin, { kind: 'book', contentId: 'samples/psalms-he' }, TICKET)!;
    expect(link).toBe(`https://reader.example.org/?book=samples%2Fpsalms-he#t=${TICKET}`);
    expect(link.indexOf(TICKET)).toBeGreaterThan(link.indexOf('#'));
    expect(new URL(link).search).not.toContain(TICKET);
  });

  it('links fetched content by its allow-listed href', () => {
    const link = buildJoinLink(
      origin,
      {
        kind: 'src',
        url: 'https://content.example.org/a b.json',
        srcOrigins: ['https://content.example.org'],
      },
      TICKET,
    )!;
    expect(link).toBe(
      `https://reader.example.org/?src=${encodeURIComponent('https://content.example.org/a%20b.json')}#t=${TICKET}`,
    );
    expect(new URL(link).searchParams.get('src')).toBe('https://content.example.org/a%20b.json');
  });

  it('links the app alone in single-book mode', () => {
    expect(buildJoinLink(`${origin}/library`, { kind: 'single-book' }, TICKET)).toBe(
      `https://reader.example.org/#t=${TICKET}`,
    );
  });

  it.each([
    ['a malformed content ID', { kind: 'book' as const, contentId: '../x' }, TICKET],
    [
      'a source off the allow-list',
      {
        kind: 'src' as const,
        url: 'https://evil.example/a.json',
        srcOrigins: ['https://content.example.org'],
      },
      TICKET,
    ],
    ['a bad ticket', { kind: 'single-book' as const }, 'x#y'],
  ])('gives no link for %s', (_name, target, ticket) => {
    expect(buildJoinLink(origin, target, ticket)).toBeNull();
  });
});
