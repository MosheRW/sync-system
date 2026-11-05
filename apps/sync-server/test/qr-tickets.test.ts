import { describe, expect, it } from 'vitest';
import { MAX_CLOCK_SKEW_MS } from '../src/limits/constants.js';
import { signCompact } from '../src/tokens/signed-blob.js';
import { CodesBlobService } from '../src/tokens/codes-blob.js';
import { QrTicketService } from '../src/tokens/qr-tickets.js';
import {
  CODES_BLOB_INFO_PREFIX,
  QR_TICKET_INFO_PREFIX,
  TokenKeyring,
  deriveAppKey,
} from '../src/tokens/token-keys.js';
import { TokenService } from '../src/tokens/token-service.js';

const SECRET = Buffer.from('q9Zt2Lx7Vb4Nm1Rt6Yw0Ue5Io3AaKd8Fj2Hs7Gp1Wc=');
const PREVIOUS = Buffer.from('Xr4Tn8Qm2Vk6Bz0Pc9Ls3Hd7Jf1Gw5Ye8Ua2Ii6Oo4=');
const NOW = 1_767_225_600_000;
const GID = 'G'.repeat(43);
const CEILING = 3600;

function qr(previous?: Buffer, current = SECRET): QrTicketService {
  const secrets = previous ? { current, previous } : { current };
  return new QrTicketService(new TokenKeyring(secrets, QR_TICKET_INFO_PREFIX), CEILING);
}

function forge(claims: unknown, ns = 'app-a'): string {
  return signCompact(JSON.stringify(claims), deriveAppKey(SECRET, ns, QR_TICKET_INFO_PREFIX));
}

describe('QrTicketService.issue (#10 AC23)', () => {
  it('issues a short, URL-safe ticket with a relative expiry', () => {
    const { ticket, expiresInMs } = qr().issue('app-a', GID, NOW, NOW, 300);
    expect(ticket.length).toBeLessThanOrEqual(256);
    expect(ticket).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(ticket.split('.')).toHaveLength(2);
    expect(expiresInMs).toBe(300_000);
    const payload = JSON.parse(Buffer.from(ticket.split('.')[0]!, 'base64url').toString()) as {
      v: number;
      g: string;
      n: number;
      e: number;
    };
    expect(payload).toEqual({ v: 1, g: GID, n: NOW, e: NOW / 1000 + 300 });
  });

  it('stays within 256 characters at the largest generation and expiry (R3)', () => {
    const svc = new QrTicketService(
      new TokenKeyring({ current: SECRET }, QR_TICKET_INFO_PREFIX),
      86_400,
    );
    const { ticket } = svc.issue(
      'a'.repeat(63),
      '_'.repeat(43),
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER - 86_400_000,
      86_400,
    );
    expect(ticket.length).toBeLessThanOrEqual(256);
  });

  it('rounds the expiry up so the ticket lives at least the full lifetime', () => {
    const { ticket } = qr().issue('app-a', GID, 1, NOW + 1, 300);
    const result = qr().verify(ticket, 'app-a', NOW + 1 + 300_000 - 1);
    expect(result.ok).toBe(true);
  });
});

describe('QrTicketService.verify (#10 AC25, R5)', () => {
  it('accepts its own ticket until it expires, then reports expired', () => {
    const svc = qr();
    const { ticket } = svc.issue('app-a', GID, 42, NOW, 300);
    expect(svc.verify(ticket, 'app-a', NOW)).toEqual({
      ok: true,
      groupId: GID,
      ticketGeneration: 42,
    });
    expect(svc.verify(ticket, 'app-a', NOW + 299_999)).toMatchObject({ ok: true });
    expect(svc.verify(ticket, 'app-a', NOW + 300_000)).toEqual({ ok: false, expired: true });
  });

  it('rejects another app, a tampered ticket and any malformed input as invalid', () => {
    const svc = qr();
    const { ticket } = svc.issue('app-a', GID, 1, NOW, 300);
    const [payload, signature] = ticket.split('.') as [string, string];
    const invalid = { ok: false, expired: false };
    expect(svc.verify(ticket, 'app-b', NOW)).toEqual(invalid);
    expect(svc.verify(`${payload}x.${signature}`, 'app-a', NOW)).toEqual(invalid);
    for (const bad of [
      undefined,
      '',
      'x',
      `${ticket}x`,
      'a'.repeat(257),
      `${'a'.repeat(213)}.${signature}`,
    ]) {
      expect(svc.verify(bad, 'app-a', NOW)).toEqual(invalid);
    }
  });

  it('rejects a correctly signed ticket with a bad claim set', () => {
    const svc = qr();
    const good = { v: 1, g: GID, n: 1, e: NOW / 1000 + 60 };
    expect(svc.verify(forge(good), 'app-a', NOW)).toMatchObject({ ok: true });
    for (const bad of [
      { ...good, v: 2 },
      { ...good, g: 'short' },
      { ...good, n: -1 },
      { ...good, n: 1.5 },
      { ...good, n: '1' },
      { ...good, e: Number.MAX_SAFE_INTEGER + 1 },
      { ...good, extra: true },
      { v: 1, g: GID, n: 1 },
      [good],
    ]) {
      expect(svc.verify(forge(bad), 'app-a', NOW)).toEqual({ ok: false, expired: false });
    }
  });

  it('rejects an implausibly far expiry, and an expired bad ticket is invalid, not expired', () => {
    const svc = qr();
    const limit = (NOW + CEILING * 1000 + MAX_CLOCK_SKEW_MS + 1000) / 1000;
    expect(svc.verify(forge({ v: 1, g: GID, n: 1, e: limit }), 'app-a', NOW).ok).toBe(true);
    expect(svc.verify(forge({ v: 1, g: GID, n: 1, e: limit + 1 }), 'app-a', NOW)).toEqual({
      ok: false,
      expired: false,
    });
    expect(svc.verify(forge({ v: 2, g: GID, n: 1, e: 1 }), 'app-a', NOW)).toEqual({
      ok: false,
      expired: false,
    });
  });

  it('accepts tickets signed under the previous secret until they expire (AC26)', () => {
    const old = qr(undefined, PREVIOUS).issue('app-a', GID, 7, NOW, 300).ticket;
    expect(qr(PREVIOUS).verify(old, 'app-a', NOW)).toMatchObject({ ok: true, ticketGeneration: 7 });
    expect(qr(PREVIOUS).verify(old, 'app-a', NOW + 300_000)).toEqual({ ok: false, expired: true });
    expect(qr().verify(old, 'app-a', NOW)).toEqual({ ok: false, expired: false });
  });
});

describe('tickets, tokens and blobs never verify as each other (#10 AC26, R4)', () => {
  const tokens = new TokenService(new TokenKeyring({ current: SECRET }));
  const blobs = new CodesBlobService(new TokenKeyring({ current: SECRET }, CODES_BLOB_INFO_PREFIX));

  it('a token is not a ticket and a ticket is not a token', () => {
    const token = tokens.issue({
      namespace: 'app-a',
      groupId: GID,
      participantId: '0b6a3f5e-8c1d-4e2f-9a7b-1c2d3e4f5a6b',
      role: 'leader',
      groupCreatedAt: NOW,
      lastActivityAt: NOW,
      term: NOW,
      now: NOW,
    });
    expect(qr().verify(token, 'app-a', NOW).ok).toBe(false);
    const { ticket } = qr().issue('app-a', GID, 1, NOW, 300);
    expect(tokens.verify(ticket, 'app-a', NOW).ok).toBe(false);
  });

  it('a blob is not a ticket and a ticket is not a blob', () => {
    const blob = blobs.sign('app-a', GID, ['C'], {
      generation: 1,
      ticketGeneration: 1,
      alphaCode: 'ABCDEFGH',
    });
    expect(qr().verify(blob, 'app-a', NOW).ok).toBe(false);
    // The same claims under the other purpose's key never verify.
    const asTicket = signCompact(
      JSON.stringify({ v: 1, g: GID, n: 1, e: NOW / 1000 + 60 }),
      deriveAppKey(SECRET, 'app-a', CODES_BLOB_INFO_PREFIX),
    );
    expect(qr().verify(asTicket, 'app-a', NOW).ok).toBe(false);
    const { ticket } = qr().issue('app-a', GID, 1, NOW, 300);
    expect(blobs.verify(ticket, 'app-a', GID)).toBeUndefined();
  });
});
