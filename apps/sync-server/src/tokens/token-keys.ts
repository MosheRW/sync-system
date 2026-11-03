import { hkdfSync } from 'node:crypto';
import type { TokenSecrets } from '../config/token-secret.js';

/** Constant HKDF salt. Changing it (or the label) invalidates every token. */
export const HKDF_SALT = 'sync-system/hkdf-salt/v1';

/** Purpose label of participant token keys; the namespace is appended (L2). */
export const HKDF_INFO_PREFIX = 'sync-system/token/v1:';

/** Purpose label of QR ticket keys (#10 D2, R4); the namespace is appended. */
export const QR_TICKET_INFO_PREFIX = 'sync-system/qr-ticket/v1:';

/** Purpose label of codes blob keys (#10 D2, R4); the namespace is appended. */
export const CODES_BLOB_INFO_PREFIX = 'sync-system/codes-blob/v1:';

/**
 * One 32-byte signing key for `namespace` and one purpose, derived from
 * `secret` (architecture 1.2). The purpose label keeps token, QR ticket and
 * codes blob keys apart, so none of them can verify as another (#10 AC26).
 */
export function deriveAppKey(
  secret: Buffer,
  namespace: string,
  infoPrefix: string = HKDF_INFO_PREFIX,
): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, HKDF_SALT, infoPrefix + namespace, 32));
}

export interface AppKeys {
  /** Signs and verifies. */
  readonly current: Buffer;
  /** `[current]` or `[current, previous]`, in verification order. */
  readonly verify: readonly Buffer[];
}

/**
 * Per-app signing keys for the current and previous secret, for one purpose,
 * derived once per namespace and cached. A token signed for app A fails the
 * signature check on app B, so it takes the same path as a random string
 * (AC8, AC15). Each purpose has its own keyring instance, so the cache can
 * never hand out one purpose's key for another (#10 R4).
 */
export class TokenKeyring {
  private readonly cache = new Map<string, AppKeys>();

  constructor(
    private readonly secrets: Pick<TokenSecrets, 'current' | 'previous'>,
    /** The HKDF purpose label; participant tokens by default. */
    readonly infoPrefix: string = HKDF_INFO_PREFIX,
  ) {}

  keysFor(namespace: string): AppKeys {
    let keys = this.cache.get(namespace);
    if (keys === undefined) {
      const current = deriveAppKey(this.secrets.current, namespace, this.infoPrefix);
      const verify =
        this.secrets.previous === undefined
          ? [current]
          : [current, deriveAppKey(this.secrets.previous, namespace, this.infoPrefix)];
      keys = { current, verify };
      this.cache.set(namespace, keys);
    }
    return keys;
  }
}
