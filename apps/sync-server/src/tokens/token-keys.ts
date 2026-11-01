import { hkdfSync } from 'node:crypto';
import type { TokenSecrets } from '../config/token-secret.js';

/** Constant HKDF salt. Changing it (or the label) invalidates every token. */
export const HKDF_SALT = 'sync-system/hkdf-salt/v1';

/** Purpose label; the namespace is appended (L2). */
export const HKDF_INFO_PREFIX = 'sync-system/token/v1:';

/** One 32-byte signing key for `namespace`, derived from `secret` (architecture 1.2). */
export function deriveAppKey(secret: Buffer, namespace: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, HKDF_INFO_PREFIX + namespace, 32));
}

export interface AppKeys {
  /** Signs and verifies. */
  readonly current: Buffer;
  /** `[current]` or `[current, previous]`, in verification order. */
  readonly verify: readonly Buffer[];
}

/**
 * Per-app signing keys for the current and previous secret, derived once per
 * namespace and cached. A token signed for app A fails the signature check on
 * app B, so it takes the same path as a random string (AC8, AC15).
 */
export class TokenKeyring {
  private readonly cache = new Map<string, AppKeys>();

  constructor(private readonly secrets: Pick<TokenSecrets, 'current' | 'previous'>) {}

  keysFor(namespace: string): AppKeys {
    let keys = this.cache.get(namespace);
    if (keys === undefined) {
      const current = deriveAppKey(this.secrets.current, namespace);
      const verify =
        this.secrets.previous === undefined
          ? [current]
          : [current, deriveAppKey(this.secrets.previous, namespace)];
      keys = { current, verify };
      this.cache.set(namespace, keys);
    }
    return keys;
  }
}
