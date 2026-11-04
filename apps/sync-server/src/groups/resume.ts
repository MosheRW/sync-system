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
 * 3. a leader token whose last activity is older than the inactivity limit
 *    plus the recovery slack: `expired`. Member tokens skip this check: they
 *    are never refreshed, so their validity comes from the group being live
 *    or recreatable and from the creation time (Q-B);
 * 4. a member on the live group's block list: `blocked`;
 * 5. a leader token that is not the live group's leader: `invalid` (item 5
 *    adds the demotion rule here);
 * 6. the group is in memory: `live`;
 * 7. otherwise `recoverable` (leader) or `waiting` (member).
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
  if (
    claims.role === 'leader' &&
    claims.lat + app.inactivityLimitMinutes * MINUTE_MS + input.refreshMaxMs <= now
  ) {
    return 'expired';
  }
  if (record !== undefined) {
    if (claims.role === 'member' && record.blockList.includes(claims.pid)) return 'blocked';
    if (claims.role === 'leader' && claims.pid !== record.leaderId) return 'invalid';
    return 'live';
  }
  return claims.role === 'leader' ? 'recoverable' : 'waiting';
}
