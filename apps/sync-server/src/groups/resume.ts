import type { TokenClaims, TokenStatus } from '@mosherw/sync-system-protocol';
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
   * When the store's keyspace started (epoch ms): the process start in
   * memory, the Redis epoch with Redis (#35 architecture 4.5). A token with
   * `iat` in or after that second was issued while the store held every
   * live group (#13 6.9 layer 2).
   */
  epoch: number;
  /** Recovery of the token's namespace is closed (#13 6.9 layer 3 (b)). */
  recoveryClosed: boolean;
  now: number;
  /** Max refresh interval in ms: the recovery slack (Q10). */
  refreshMaxMs: number;
}

/**
 * Whether a leader token takes the lead of a recreated group from the
 * leader that recreated it (#13 6.6.1, restart only, RC6). All of:
 * 1. the record was recreated in this process (so: after a restart);
 * 2. a leader token of another participant than the current leader;
 * 3. granted before the restart (`term < recoveredAt`; every grant made in
 *    this process has `term >= recoveredAt` by the `nextTerm` floor);
 * 4. later than the recreator or the last superseder (`term > anchorTerm`,
 *    strict);
 * 5. inside its `lat` window and the max session (RC8).
 */
export function canSupersede(
  record: Pick<GroupRecord, 'recoveredAt' | 'anchorTerm' | 'leaderId'>,
  claims: TokenClaims,
  app: Pick<AppConfig, 'inactivityLimitMinutes' | 'maxSessionMinutes'>,
  now: number,
  refreshMaxMs: number,
): boolean {
  if (record.recoveredAt === undefined || record.anchorTerm === undefined) return false;
  return (
    claims.role === 'leader' &&
    claims.pid !== record.leaderId &&
    claims.term < record.recoveredAt &&
    claims.term > record.anchorTerm &&
    claims.lat + app.inactivityLimitMinutes * MINUTE_MS + refreshMaxMs > now &&
    claims.gct + app.maxSessionMinutes * MINUTE_MS > now
  );
}

/** True when the token was issued in the store's epoch (#13 6.9 layer 2, RC17, #35 4.5). */
export function issuedInEpoch(claims: TokenClaims, epoch: number): boolean {
  return claims.iat >= Math.floor(epoch / 1000);
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
  if (record === undefined && (issuedInEpoch(claims, input.epoch) || input.recoveryClosed)) {
    return 'ended';
  }
  if (claims.gct + app.maxSessionMinutes * MINUTE_MS <= now) return 'expired';
  const latExpired =
    claims.lat + app.inactivityLimitMinutes * MINUTE_MS + input.refreshMaxMs <= now;
  if (record !== undefined) {
    // A valid supersede is the only exemption from the (stale) block list.
    if (canSupersede(record, claims, app, now, input.refreshMaxMs)) return 'live';
    if (record.blockList.includes(claims.pid)) return 'blocked';
    if (claims.pid === record.leaderId) return latExpired ? 'expired' : 'live';
    return 'live';
  }
  if (claims.role === 'leader' && latExpired) return 'expired';
  return claims.role === 'leader' ? 'recoverable' : 'waiting';
}
