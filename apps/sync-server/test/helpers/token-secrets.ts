import {
  type TokenSecretSource,
  type TokenSecrets,
  redactTokenSecrets,
} from '../../src/config/token-secret.js';

/**
 * A `TokenSecrets` handle for `TokenKeyring` built from test Buffers (or an
 * existing handle, returned as is). The handle keeps a copy and gives no
 * bytes back out (#58 Gate 3 round 3).
 */
export function testSecrets(
  secrets:
    | TokenSecrets
    | { readonly current: Buffer; readonly previous?: Buffer; readonly source?: TokenSecretSource },
): TokenSecrets {
  if (!('current' in secrets)) return secrets;
  return redactTokenSecrets({ ...secrets, source: secrets.source ?? 'env' });
}
