import { hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  HKDF_INFO_PREFIX,
  HKDF_SALT,
  TokenKeyring,
  deriveAppKey,
} from '../src/tokens/token-keys.js';

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

  it('caches keys and lists current before previous', () => {
    const ring = new TokenKeyring({ current: SECRET, previous: PREVIOUS });
    const keys = ring.keysFor('app-a');
    expect(ring.keysFor('app-a')).toBe(keys);
    expect(keys.verify).toHaveLength(2);
    expect(keys.verify[0]).toBe(keys.current);
    expect(keys.verify[1]!.equals(deriveAppKey(PREVIOUS, 'app-a'))).toBe(true);
    expect(new TokenKeyring({ current: SECRET }).keysFor('app-a').verify).toHaveLength(1);
  });
});
