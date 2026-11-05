import { randomUUID } from 'node:crypto';
import type { TokenClaims } from '@sync-system/protocol';

const HEADER = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
const TTL_SECONDS = 365 * 86_400;

/** A group ID in the real format. */
export function groupIdOf(char: string): string {
  return char.repeat(43);
}

/**
 * A decodable token for client tests (the client never verifies signatures).
 * Times default to `Date.now()`, so fake timers apply.
 */
export function fakeToken(overrides: Partial<TokenClaims> = {}): string {
  const nowMs = Date.now();
  const iat = overrides.iat ?? Math.floor(nowMs / 1000);
  const claims: TokenClaims = {
    v: 2,
    aud: 'app-a',
    gid: groupIdOf('G'),
    pid: randomUUID(),
    role: 'leader',
    gct: nowMs,
    lat: nowMs,
    term: overrides.gct ?? nowMs,
    iat,
    exp: iat + TTL_SECONDS,
    ...overrides,
  };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${HEADER}.${payload}.${'A'.repeat(43)}`;
}
