import type { TokenClaims, TokenStatus } from '@sync-system/protocol';
import type { AppConfig } from '../apps/app-registry.js';
import type { GroupRecord } from './group-store.js';

const MINUTE_MS = 60_000;

export interface ClassifyInput {
  /** Verified claims (signature, audience, plausibility and `exp` already checked). */
  claims: TokenClaims;
  app: AppConfig;
  /** The group if it is in memory. */
  record: GroupRecord | undefined;
  /** The group ended in this process (EndedGroups). */
  ended: boolean;
  /**
   * When this process started (epoch ms, the injected clock at
   * construction). A token with `iat` in or after that second was issued
   * here (#13 6.9 layer 2).
   */
  processStartedAt: number;
  /** Recovery of the token's namespace is closed (#13 6.9 layer 3 (b)). */
  recoveryClosed: boolean;
  now: number;
  /** Max refresh interval in ms: the recovery slack (Q10). */
  refreshMaxMs: number;
}

/** True when the token was issued by this process (#13 6.9 layer 2, RC17). */
export function issuedInThisProcess(claims: TokenClaims, processStartedAt: number): boolean {
  return claims.iat >= Math.floor(processStartedAt / 1000);
}

/**
 * Status of a verified token (architecture 4.2, #13 6.9), shared by
 * tokens.check and group.resume so both always agree. In order:
 * 1. the group ended in this process: `ended`;
 * 1b. the group is not in memory and the token was issued by this process,
 *    or recovery of the namespace is closed: `ended`. Tokens are only
 *    issued while their group is in memory, and a group leaves memory only
 *    by ending, so such a group ended here (#13 RC17);
 * 2. older than the app's max session time: `expired`;
 * 3. the group is in memory (#13 D4: the role comes from the record, not
 *    the token):
 *    - the participant is on the block list: `blocked`, whatever the token
 *      role (RC8);
 *    - it is the record's leader: a leader return, with any token role, so
 *      the `lat` bound applies (L2): `expired` past it, else `live`;
 *    - anyone else, a displaced or stale leader token included: `live`, a
 *      member resume (AC24); a `lat`-expired leader token of someone else
 *      still resumes as a member;
 * 4. not in memory: a leader token past its `lat` bound is `expired`
 *    (it never recreates, RC8); else `recoverable` (leader) or `waiting`
 *    (member).
 */
export function classifyToken(input: ClassifyInput): TokenStatus {
  const { claims, app, record, now } = input;
  if (input.ended) return 'ended';
  if (
    record === undefined &&
    (issuedInThisProcess(claims, input.processStartedAt) || input.recoveryClosed)
  ) {
    return 'ended';
  }
  if (claims.gct + app.maxSessionMinutes * MINUTE_MS <= now) return 'expired';
  const latExpired =
    claims.lat + app.inactivityLimitMinutes * MINUTE_MS + input.refreshMaxMs <= now;
  if (record !== undefined) {
    if (record.blockList.includes(claims.pid)) return 'blocked';
    if (claims.pid === record.leaderId) return latExpired ? 'expired' : 'live';
    return 'live';
  }
  if (claims.role === 'leader' && latExpired) return 'expired';
  return claims.role === 'leader' ? 'recoverable' : 'waiting';
}
