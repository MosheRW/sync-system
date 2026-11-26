import { describe, expect, it } from 'vitest';
import { type BlobCodes, CodesBlobService } from '../src/tokens/codes-blob.js';
import { signCompact } from '../src/tokens/signed-blob.js';
import { CODES_BLOB_INFO_PREFIX, TokenKeyring, deriveAppKey } from '../src/tokens/token-keys.js';
import { testSecrets } from './helpers/token-secrets.js';

const SECRET = Buffer.from('q9Zt2Lx7Vb4Nm1Rt6Yw0Ue5Io3AaKd8Fj2Hs7Gp1Wc=');
const PREVIOUS = Buffer.from('Xr4Tn8Qm2Vk6Bz0Pc9Ls3Hd7Jf1Gw5Ye8Ua2Ii6Oo4=');
const GID = 'G'.repeat(43);
const OTHER_GID = 'H'.repeat(43);

const A_CODES: BlobCodes = {
  generation: 1_767_225_600_000,
  ticketGeneration: 1_767_225_600_000,
  groupCode: '012345',
  doorCode: '678901',
};

function service(previous?: Buffer, current = SECRET): CodesBlobService {
  const secrets = previous ? { current, previous } : { current };
  return new CodesBlobService(new TokenKeyring(testSecrets(secrets), CODES_BLOB_INFO_PREFIX));
}

function forge(claims: unknown, ns = 'app-a'): string {
  return signCompact(JSON.stringify(claims), deriveAppKey(SECRET, ns, CODES_BLOB_INFO_PREFIX));
}

const GOOD = { v: 1, g: GID, n: 10, t: 5, m: 'AD', gc: '012345', dc: '678901' };

describe('CodesBlobService (#10 AC32, AC33)', () => {
  it('round-trips the methods, codes and both generations', () => {
    const svc = service();
    const blob = svc.sign('app-a', GID, ['D', 'A'], A_CODES);
    expect(blob).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(svc.verify(blob, 'app-a', GID)).toEqual({
      methods: ['A', 'D'],
      codes: { ...A_CODES, alphaCode: undefined },
    });
  });

  it('covers B and C sets', () => {
    const svc = service();
    const codes = {
      generation: 9,
      ticketGeneration: 3,
      groupCode: '999999',
      alphaCode: 'ABCDEFGH',
    };
    const blob = svc.sign('app-a', GID, ['B', 'C', 'D'], codes);
    expect(svc.verify(blob, 'app-a', GID)).toEqual({
      methods: ['B', 'C', 'D'],
      codes: { ...codes, doorCode: undefined },
    });
  });

  it('stays well under 512 characters at its largest (pinned)', () => {
    const blob = service().sign('a'.repeat(63), '_'.repeat(43), ['A', 'C', 'D'], {
      generation: Number.MAX_SAFE_INTEGER,
      ticketGeneration: Number.MAX_SAFE_INTEGER,
      groupCode: '999999',
      doorCode: '888888',
      alphaCode: 'ZZZZZZZZ',
    });
    expect(blob.length).toBeLessThanOrEqual(300);
  });

  it('rejects another group, another app, a tampered blob and other shapes', () => {
    const svc = service();
    const blob = svc.sign('app-a', GID, ['A'], A_CODES);
    expect(svc.verify(blob, 'app-a', OTHER_GID)).toBeUndefined();
    expect(svc.verify(blob, 'app-b', GID)).toBeUndefined();
    const [payload, signature] = blob.split('.') as [string, string];
    expect(svc.verify(`${payload}A.${signature}`, 'app-a', GID)).toBeUndefined();
    for (const bad of [undefined, '', 1, `${blob}.x`, 'a'.repeat(513)]) {
      expect(svc.verify(bad, 'app-a', GID)).toBeUndefined();
    }
  });

  it('accepts the previous secret, and not a blob from an unknown secret', () => {
    const old = service(undefined, PREVIOUS).sign('app-a', GID, ['A'], A_CODES);
    expect(service(PREVIOUS).verify(old, 'app-a', GID)).toBeDefined();
    expect(service().verify(old, 'app-a', GID)).toBeUndefined();
  });

  it('accepts a forged-but-correctly-signed good claim set (control)', () => {
    expect(service().verify(forge(GOOD), 'app-a', GID)).toBeDefined();
  });

  it.each([
    ['missing t', { ...GOOD, t: undefined }],
    ['negative t', { ...GOOD, t: -1 }],
    ['fractional t', { ...GOOD, t: 1.5 }],
    ['t above n', { ...GOOD, t: 11 }],
    ['string n', { ...GOOD, n: '10' }],
    ['version 2', { ...GOOD, v: 2 }],
    ['unknown key', { ...GOOD, x: 1 }],
    ['empty methods', { ...GOOD, m: '' }],
    ['A with B', { ...GOOD, m: 'AB', dc: '678901' }],
    ['non-canonical methods', { ...GOOD, m: 'DA' }],
    ['duplicate methods', { ...GOOD, m: 'AAD' }],
    ['unknown method', { ...GOOD, m: 'AE' }],
    ['missing door code for A', { ...GOOD, dc: undefined }],
    ['door code equal to group code', { ...GOOD, dc: '012345' }],
    ['door code without A', { ...GOOD, m: 'BD' }],
    ['alpha code without C', { ...GOOD, ac: 'ABCDEFGH' }],
    ['missing alpha code for C', { ...GOOD, m: 'ACD' }],
    ['bad group code', { ...GOOD, gc: '12345' }],
    ['bad alpha code', { ...GOOD, m: 'ACD', ac: 'ABCDEFG0' }],
    ['numeric group code', { ...GOOD, gc: 12345 }],
    ['group code for D only', { v: 1, g: GID, n: 1, t: 1, m: 'D', gc: '012345' }],
  ])('rejects a signed blob with %s (D12, R5)', (_name, claims) => {
    expect(service().verify(forge(claims), 'app-a', GID)).toBeUndefined();
  });

  it('accepts a D-only blob without codes', () => {
    expect(service().verify(forge({ v: 1, g: GID, n: 2, t: 2, m: 'D' }), 'app-a', GID)).toEqual({
      methods: ['D'],
      codes: {
        generation: 2,
        ticketGeneration: 2,
        groupCode: undefined,
        doorCode: undefined,
        alphaCode: undefined,
      },
    });
  });
});
