import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_CLOCK_SKEW_MS, TOKEN_TTL_SECONDS } from '../src/limits/constants.js';
import { TOKEN_HEADER_SEGMENT } from '../src/tokens/jwt.js';
import { TokenKeyring, deriveAppKey } from '../src/tokens/token-keys.js';
import { TokenService } from '../src/tokens/token-service.js';
import { b64url, claimsAt, claimsOf, forge, headerSegment } from './helpers/tokens.js';
import { testSecrets } from './helpers/token-secrets.js';

const SECRET = Buffer.from('q9Zt2Lx7Vb4Nm1Rt6Yw0Ue5Io3AaKd8Fj2Hs7Gp1Wc=');
const PREVIOUS = Buffer.from('Xr4Tn8Qm2Vk6Bz0Pc9Ls3Hd7Jf1Gw5Ye8Ua2Ii6Oo4=');
const NOW = 1_767_225_600_000;
const GID = 'g'.repeat(43);
const PID = randomUUID();
const KEY_A = deriveAppKey(SECRET, 'app-a');

function service(previous?: Buffer): TokenService {
  return new TokenService(
    new TokenKeyring(testSecrets(previous ? { current: SECRET, previous } : { current: SECRET })),
  );
}

function issueAt(
  svc: TokenService,
  now = NOW,
  overrides: Partial<{ role: 'leader' | 'member' }> = {},
) {
  return svc.issue({
    namespace: 'app-a',
    groupId: GID,
    participantId: PID,
    role: overrides.role ?? 'leader',
    groupCreatedAt: now - 60_000,
    lastActivityAt: now - 1_000,
    term: now - 30_000,
    now,
  });
}

describe('TokenService.issue (AC5)', () => {
  it('carries every claim in a fixed order, with exp exactly 365 days after iat', () => {
    const token = issueAt(service());
    const payload = Buffer.from(token.split('.')[1]!, 'base64url').toString();
    expect(Object.keys(JSON.parse(payload) as object)).toEqual([
      'v',
      'aud',
      'gid',
      'pid',
      'role',
      'gct',
      'lat',
      'term',
      'iat',
      'exp',
    ]);
    expect(claimsOf(token)).toEqual({
      v: 2,
      aud: 'app-a',
      gid: GID,
      pid: PID,
      role: 'leader',
      gct: NOW - 60_000,
      lat: NOW - 1_000,
      term: NOW - 30_000,
      iat: NOW / 1000,
      exp: NOW / 1000 + 31_536_000,
    });
    expect(TOKEN_TTL_SECONDS).toBe(31_536_000);
    expect(token.length).toBeLessThan(400);
  });

  it('verifies what it issues, for both roles', () => {
    const svc = service();
    for (const role of ['leader', 'member'] as const) {
      const result = svc.verify(issueAt(svc, NOW, { role }), 'app-a', NOW);
      expect(result).toMatchObject({ ok: true, viaPrevious: false, claims: { role, pid: PID } });
    }
  });

  it('never signs with the previous secret (AC2)', () => {
    const token = issueAt(service(PREVIOUS));
    expect(service().verify(token, 'app-a', NOW).ok).toBe(true);
    expect(
      new TokenService(new TokenKeyring(testSecrets({ current: PREVIOUS }))).verify(
        token,
        'app-a',
        NOW,
      ).ok,
    ).toBe(false);
  });
});

describe('TokenService.verify (AC7, AC8, M2)', () => {
  const svc = service();

  it('accepts a token signed with the previous secret and says so (AC2)', () => {
    const old = issueAt(new TokenService(new TokenKeyring(testSecrets({ current: PREVIOUS }))));
    const result = service(PREVIOUS).verify(old, 'app-a', NOW);
    expect(result).toMatchObject({ ok: true, viaPrevious: true });
    expect(service().verify(old, 'app-a', NOW).ok).toBe(false);
  });

  it('re-signs the same claims with the current secret', () => {
    const old = issueAt(new TokenService(new TokenKeyring(testSecrets({ current: PREVIOUS }))));
    const both = service(PREVIOUS);
    const result = both.verify(old, 'app-a', NOW);
    if (!result.ok) throw new Error('expected ok');
    const fresh = both.resign(result.claims, 'app-a');
    expect(claimsOf(fresh)).toEqual(claimsOf(old));
    expect(service().verify(fresh, 'app-a', NOW)).toMatchObject({ ok: true, viaPrevious: false });
  });

  it('rejects another app’s token through the signature, like garbage (AC8)', () => {
    const token = issueAt(svc);
    expect(svc.verify(token, 'app-b', NOW)).toEqual({ ok: false });
    // Even re-signed with app B's key, the aud claim is checked as a second line.
    const keyB = deriveAppKey(SECRET, 'app-b');
    expect(svc.verify(forge(claimsOf(token), keyB), 'app-b', NOW)).toEqual({ ok: false });
    expect(svc.verify('garbage', 'app-b', NOW)).toEqual({ ok: false });
  });

  it('rejects forged headers even with the right key (R1)', () => {
    const claims = claimsAt(NOW);
    for (const header of [
      headerSegment({ alg: 'none', typ: 'JWT' }),
      headerSegment({ alg: 'HS512', typ: 'JWT' }),
      headerSegment({ alg: 'RS256', typ: 'JWT' }),
      headerSegment({ alg: 'HS256', typ: 'JWT', kid: 'x' }),
      headerSegment({ typ: 'JWT', alg: 'HS256' }),
    ]) {
      expect(svc.verify(forge(claims, KEY_A, { header }), 'app-a', NOW).ok).toBe(false);
    }
    expect(svc.verify(forge(claims, KEY_A), 'app-a', NOW).ok).toBe(true);
    expect(svc.verify(forge(claims, Buffer.alloc(32, 1)), 'app-a', NOW).ok).toBe(false);
    expect(
      svc.verify(`${TOKEN_HEADER_SEGMENT}.${b64url(JSON.stringify(claims))}.`, 'app-a', NOW).ok,
    ).toBe(false);
  });

  it('rejects every missing or wrongly typed claim', () => {
    const claims = claimsAt(NOW);
    for (const key of Object.keys(claims)) {
      const missing: Record<string, unknown> = { ...claims };
      delete missing[key];
      expect(svc.verify(forge(missing, KEY_A), 'app-a', NOW).ok, `missing ${key}`).toBe(false);
      expect(svc.verify(forge({ ...claims, [key]: 'x' }, KEY_A), 'app-a', NOW).ok, key).toBe(false);
    }
  });

  it('rejects an unknown format version, an expired exp and an over-long token', () => {
    expect(svc.verify(forge(claimsAt(NOW, { v: 1 }), KEY_A), 'app-a', NOW).ok).toBe(false);
    const issuedLongAgo = NOW - (TOKEN_TTL_SECONDS + 10) * 1000;
    const expired = forge(claimsAt(issuedLongAgo), KEY_A);
    expect(svc.verify(expired, 'app-a', NOW).ok).toBe(false);
    const padded = forge({ ...claimsAt(NOW), pad: 'x'.repeat(1600) }, KEY_A);
    expect(padded.length).toBeGreaterThan(2048);
    expect(svc.verify(padded, 'app-a', NOW).ok).toBe(false);
  });

  it('ignores unknown extra claims and never carries them into a re-signed token (AC40, L3)', () => {
    const token = forge({ ...claimsAt(NOW), codes: ['abc'], extra: { x: 1 } }, KEY_A);
    const result = svc.verify(token, 'app-a', NOW);
    if (!result.ok) throw new Error('expected ok');
    expect(result.claims).not.toHaveProperty('codes');
    const payload = Buffer.from(svc.resign(result.claims, 'app-a').split('.')[1]!, 'base64url');
    expect(payload.toString()).not.toContain('codes');
  });

  it('keeps the leadership term when it re-signs a token (#13 RC5)', () => {
    const token = forge(claimsAt(NOW, { term: NOW + 7 }), KEY_A);
    const result = svc.verify(token, 'app-a', NOW);
    if (!result.ok) throw new Error('expected ok');
    expect(claimsOf(svc.resign(result.claims, 'app-a')).term).toBe(NOW + 7);
  });

  it('rejects implausible claims (M2)', () => {
    const skew = MAX_CLOCK_SKEW_MS;
    const future = NOW + skew + 1_000;
    const futureIat = Math.floor(future / 1000);
    const cases: Array<[string, Record<string, unknown>]> = [
      ['exp - iat is not the TTL', claimsAt(NOW, { exp: Math.floor(NOW / 1000) + 10 })],
      ['a far-future exp', claimsAt(NOW, { exp: Number.MAX_SAFE_INTEGER })],
      [
        'iat beyond the skew',
        claimsAt(NOW, { iat: futureIat, exp: futureIat + TOKEN_TTL_SECONDS }),
      ],
      ['gct beyond the skew', claimsAt(NOW, { gct: future, lat: future, term: future })],
      ['term beyond the skew (#13 RC5)', claimsAt(NOW, { term: future })],
      ['lat beyond the skew', claimsAt(NOW, { lat: future })],
      ['lat after issue', claimsAt(NOW, { lat: Math.floor(NOW / 1000) * 1000 + 1_001 })],
      ['lat before gct', claimsAt(NOW, { lat: NOW - 1 })],
      ['term before gct (#13 RC5)', claimsAt(NOW, { term: NOW - 1 })],
      [
        'gct in the year 3000',
        claimsAt(NOW, {
          gct: 32_503_680_000_000,
          lat: 32_503_680_000_000,
          term: 32_503_680_000_000,
        }),
      ],
    ];
    for (const [label, claims] of cases) {
      expect(svc.verify(forge(claims, KEY_A), 'app-a', NOW).ok, label).toBe(false);
    }
  });

  it('tolerates times up to the skew in the future', () => {
    const ahead = NOW + MAX_CLOCK_SKEW_MS - 1_000;
    expect(svc.verify(forge(claimsAt(ahead), KEY_A), 'app-a', NOW).ok).toBe(true);
  });

  it('returns the same frozen failure for every cause, with no token content', () => {
    const failures = [
      svc.verify('garbage', 'app-a', NOW),
      svc.verify(issueAt(svc), 'app-b', NOW),
      svc.verify(forge(claimsAt(NOW, { v: 1 }), KEY_A), 'app-a', NOW),
    ];
    for (const failure of failures) expect(failure).toBe(failures[0]);
    expect(JSON.stringify(failures[0])).toBe('{"ok":false}');
  });
});
