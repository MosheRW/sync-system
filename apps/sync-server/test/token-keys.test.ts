import { hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CODES_BLOB_INFO_PREFIX,
  HKDF_INFO_PREFIX,
  HKDF_SALT,
  QR_TICKET_INFO_PREFIX,
  TokenKeyring,
  deriveAppKey,
} from '../src/tokens/token-keys.js';
import { testSecrets } from './helpers/token-secrets.js';

const SECRET = Buffer.from('q9Zt2Lx7Vb4Nm1Rt6Yw0Ue5Io3AaKd8Fj2Hs7Gp1Wc=');
const PREVIOUS = Buffer.from('Xr4Tn8Qm2Vk6Bz0Pc9Ls3Hd7Jf1Gw5Ye8Ua2Ii6Oo4=');

describe('per-app keys (architecture 1.2, R5)', () => {
  it('uses HKDF-SHA256 with a constant salt and the purpose label plus namespace in info', () => {
    const expected = Buffer.from(
      hkdfSync('sha256', SECRET, HKDF_SALT, 'sync-system/token/v1:app-a', 32),
    );
    expect(HKDF_INFO_PREFIX).toBe('sync-system/token/v1:');
    expect(deriveAppKey(SECRET, 'app-a').equals(expected)).toBe(true);
    expect(deriveAppKey(SECRET, 'app-a')).toHaveLength(32);
  });

  it('gives different keys per namespace and per secret', () => {
    const a = deriveAppKey(SECRET, 'app-a');
    expect(a.equals(deriveAppKey(SECRET, 'app-b'))).toBe(false);
    expect(a.equals(deriveAppKey(PREVIOUS, 'app-a'))).toBe(false);
    expect(a.equals(SECRET)).toBe(false);
  });

  it('keeps token keys byte-identical to the #5 keys (pinned, #10 R4)', () => {
    expect(deriveAppKey(SECRET, 'app-a').toString('hex')).toBe(
      '747929d9ff1fc20e6074c41b54dc9f1b6e3e4552ad936eea830ad870cc6a4db7',
    );
    expect(
      new TokenKeyring(testSecrets({ current: SECRET })).keysFor('app-a').current.toString('hex'),
    ).toBe('747929d9ff1fc20e6074c41b54dc9f1b6e3e4552ad936eea830ad870cc6a4db7');
  });

  it('derives separate keys per purpose with the exact HKDF labels (#10 R4, AC26)', () => {
    expect(QR_TICKET_INFO_PREFIX).toBe('sync-system/qr-ticket/v1:');
    expect(CODES_BLOB_INFO_PREFIX).toBe('sync-system/codes-blob/v1:');
    const qr = deriveAppKey(SECRET, 'app-a', QR_TICKET_INFO_PREFIX);
    const blob = deriveAppKey(SECRET, 'app-a', CODES_BLOB_INFO_PREFIX);
    expect(
      qr.equals(
        Buffer.from(hkdfSync('sha256', SECRET, HKDF_SALT, 'sync-system/qr-ticket/v1:app-a', 32)),
      ),
    ).toBe(true);
    expect(
      blob.equals(
        Buffer.from(hkdfSync('sha256', SECRET, HKDF_SALT, 'sync-system/codes-blob/v1:app-a', 32)),
      ),
    ).toBe(true);
    const token = deriveAppKey(SECRET, 'app-a');
    expect(qr.equals(token)).toBe(false);
    expect(blob.equals(token)).toBe(false);
    expect(qr.equals(blob)).toBe(false);
    expect(qr.equals(deriveAppKey(SECRET, 'app-b', QR_TICKET_INFO_PREFIX))).toBe(false);
    const qrRing = new TokenKeyring(
      testSecrets({ current: SECRET, previous: PREVIOUS }),
      QR_TICKET_INFO_PREFIX,
    );
    expect(qrRing.keysFor('app-a').current.equals(qr)).toBe(true);
    expect(
      qrRing
        .keysFor('app-a')
        .verify[1]!.equals(deriveAppKey(PREVIOUS, 'app-a', QR_TICKET_INFO_PREFIX)),
    ).toBe(true);
  });

  it('caches keys and lists current before previous', () => {
    const ring = new TokenKeyring(testSecrets({ current: SECRET, previous: PREVIOUS }));
    const keys = ring.keysFor('app-a');
    expect(ring.keysFor('app-a')).toBe(keys);
    expect(keys.verify).toHaveLength(2);
    expect(keys.verify[0]).toBe(keys.current);
    expect(keys.verify[1]!.equals(deriveAppKey(PREVIOUS, 'app-a'))).toBe(true);
    expect(new TokenKeyring(testSecrets({ current: SECRET })).keysFor('app-a').verify).toHaveLength(
      1,
    );
  });
});
