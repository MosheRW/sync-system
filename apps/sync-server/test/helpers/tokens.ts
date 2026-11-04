import { createHmac, randomUUID } from 'node:crypto';
import { type TokenClaims, decodeTokenClaims } from '@sync-system/protocol';
import { TOKEN_TTL_SECONDS } from '../../src/limits/constants.js';
import { TOKEN_HEADER_SEGMENT } from '../../src/tokens/jwt.js';

/** Test-only token tools: forging, re-encoding and decoding. */

export function b64url(text: string | Buffer): string {
  return (typeof text === 'string' ? Buffer.from(text, 'utf8') : text).toString('base64url');
}

export function headerSegment(header: unknown): string {
  return b64url(JSON.stringify(header));
}

/** Signs `header.payload` with HMAC-SHA256 like the server, for any header and payload. */
export function forge(
  payload: unknown,
  key: Buffer,
  options: { header?: string; algorithm?: 'sha256' | 'sha512' } = {},
): string {
  const header = options.header ?? TOKEN_HEADER_SEGMENT;
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signingInput = `${header}.${b64url(body)}`;
  const signature = createHmac(options.algorithm ?? 'sha256', key)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${signature}`;
}

/** A claim set that is valid at `nowMs`, with overrides. */
export function claimsAt(nowMs: number, overrides: Partial<Record<string, unknown>> = {}) {
  const iat = Math.floor(nowMs / 1000);
  return {
    v: 2,
    aud: 'app-a',
    gid: 'G'.repeat(43),
    pid: randomUUID(),
    role: 'leader',
    gct: nowMs,
    lat: nowMs,
    term: nowMs,
    iat,
    exp: iat + TOKEN_TTL_SECONDS,
    ...overrides,
  };
}

/** Unverified claims of a token the test received; throws if it is not decodable. */
export function claimsOf(token: unknown): TokenClaims {
  const claims = decodeTokenClaims(token);
  if (claims === undefined) throw new Error('token is not decodable');
  return claims;
}
