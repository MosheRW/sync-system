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
  now: number;
  /** Max refresh interval in ms: the recovery slack (Q10). */
  refreshMaxMs: number;
}

/**
 * Status of a verified token (architecture 4.2), shared by tokens.check and
 * group.resume. In order:
 * 1. the group ended in this process: `ended`;
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
