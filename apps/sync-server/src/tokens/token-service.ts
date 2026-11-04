import {
  TOKEN_FORMAT_VERSION,
  type TokenClaims,
  type TokenRole,
  parseClaimsSegment,
} from '@sync-system/protocol';
import { MAX_CLOCK_SKEW_MS, TOKEN_TTL_SECONDS } from '../limits/constants.js';
import { signHs256, verifyHs256 } from './jwt.js';
import type { TokenKeyring } from './token-keys.js';

export interface IssueInput {
  namespace: string;
  groupId: string;
  participantId: string;
  role: TokenRole;
  /** Group creation time, epoch ms. */
  groupCreatedAt: number;
  /** The leader's last activity, epoch ms. */
  lastActivityAt: number;
  /** The group's current leadership term (#13 D3); always `record.term`. */
  term: number;
  /** Issue time, epoch ms. */
  now: number;
}

export type VerifyResult =
  | { ok: true; claims: TokenClaims; viaPrevious: boolean }
  /** No reason is given: every failure must look the same (AC8, AC15). */
  | { ok: false };

const INVALID: VerifyResult = Object.freeze({ ok: false });

/**
 * Serializes exactly the ten known claims in a fixed order (L3), so a
 * re-signed token never carries forward a claim this server did not write,
 * and `resign` keeps the leadership term (#13 RC5).
 */
function payloadJson(claims: TokenClaims): string {
  return JSON.stringify({
    v: claims.v,
    aud: claims.aud,
    gid: claims.gid,
    pid: claims.pid,
    role: claims.role,
    gct: claims.gct,
    lat: claims.lat,
    term: claims.term,
    iat: claims.iat,
    exp: claims.exp,
  });
}

/**
 * Plausibility of verified claims (M2). The server is the only signer, so
 * this matters when a key leaked or the clock stepped: implausible times are
 * rejected as invalid.
 */
function plausible(claims: TokenClaims, now: number): boolean {
  const latest = now + MAX_CLOCK_SKEW_MS;
  return (
    claims.exp - claims.iat === TOKEN_TTL_SECONDS &&
    claims.iat * 1000 <= latest &&
    claims.gct <= latest &&
    claims.lat <= latest &&
    claims.lat <= claims.iat * 1000 + 1000 &&
    claims.lat >= claims.gct &&
    // #13 RC5: a term is a time-based grant, never ahead of the clock.
    claims.term >= claims.gct &&
    claims.term <= latest
  );
}

/**
 * Issues and verifies participant tokens (architecture 4.1, 4.2). Never logs,
 * and never throws or returns anything that contains token content.
 */
export class TokenService {
  constructor(private readonly keyring: TokenKeyring) {}

  issue(input: IssueInput): string {
    const iat = Math.floor(input.now / 1000);
    return this.sign(
      {
        v: TOKEN_FORMAT_VERSION,
        aud: input.namespace,
        gid: input.groupId,
        pid: input.participantId,
        role: input.role,
        gct: input.groupCreatedAt,
        lat: input.lastActivityAt,
        term: input.term,
        iat,
        exp: iat + TOKEN_TTL_SECONDS,
      },
      input.namespace,
    );
  }

  /** The same claims signed with the current key (AC2 re-sign). */
  resign(claims: TokenClaims, namespace: string): string {
    return this.sign(claims, namespace);
  }

  /**
   * Signature first (current key, then previous), then the claims: schema,
   * format version, audience, plausibility and expiry. `viaPrevious` tells
   * the caller to hand back a re-signed token (AC2).
   */
  verify(token: unknown, namespace: string, now: number): VerifyResult {
    const verified = verifyHs256(token, this.keyring.keysFor(namespace).verify);
    if (verified === undefined) return INVALID;
    const claims = parseClaimsSegment(verified.payloadSegment);
    if (claims === undefined) return INVALID;
    if (claims.v !== TOKEN_FORMAT_VERSION || claims.aud !== namespace) return INVALID;
    if (!plausible(claims, now)) return INVALID;
    if (claims.exp * 1000 <= now) return INVALID;
    return { ok: true, claims, viaPrevious: verified.keyIndex > 0 };
  }

  private sign(claims: TokenClaims, namespace: string): string {
    return signHs256(payloadJson(claims), this.keyring.keysFor(namespace).current);
  }
}
