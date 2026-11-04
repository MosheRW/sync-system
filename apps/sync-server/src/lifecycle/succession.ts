import type { GroupRecord } from '../groups/group-store.js';

/**
 * The next leader term (#13 D3): strictly above the previous one, never
 * below the clock, and never below `floor` (the record's `recoveredAt`), so
 * every grant made in this process for a recreated group has
 * `term >= recoveredAt`, whatever the clock does.
 */
export function nextTerm(prev: number, now: number, floor = 0): number {
  return Math.max(prev + 1, now, floor);
}

/**
 * Who takes the lead when the grace period ends (#13 AC20, Q2.2, AC12): the
 * vice-leader if it is connected, else the earliest admitted connected
 * member. Never the current leader, never the displaced leader (the take-back
 * holder), never a blocked participant; pending joiners and parked
 * participants are not on the roster, so they never are either. Undefined
 * when nobody qualifies.
 */
export function pickSuccessor(
  record: Pick<
    GroupRecord,
    'leaderId' | 'viceId' | 'displacedLeaderId' | 'roster' | 'blockList' | 'participantIds'
  >,
  isConnected: (pid: string) => boolean,
): string | undefined {
  const eligible = (pid: string): boolean =>
    pid !== record.leaderId &&
    pid !== record.displacedLeaderId &&
    !record.blockList.includes(pid) &&
    record.participantIds.includes(pid) &&
    isConnected(pid);
  if (record.viceId !== undefined && eligible(record.viceId)) return record.viceId;
  const candidates = record.roster
    .filter((entry) => entry.connected && eligible(entry.pid))
    .sort((a, b) => a.admittedSeq - b.admittedSeq);
  return candidates[0]?.pid;
}
