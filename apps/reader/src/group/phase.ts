import type { ConnectionState, GroupState, SyncIndicator } from '@sync-system/react';
import type { CompareResult } from '../content/compare.js';
import type { FollowMode } from './session-store.js';

/**
 * The reader's group phase (#24 architecture 7.1). Pure: derived from the
 * client snapshot and reader-local state. One value drives the indicator,
 * the sheet's view and which overlays exist.
 */
export type Phase =
  | 'off'
  | 'solo'
  | 'joining'
  | 'awaiting'
  | 'resuming'
  | 'checking'
  | 'mismatch-block'
  | 'mismatch-warn'
  | 'member'
  | 'leader'
  | 'disconnected';

export interface PhaseInput {
  /** Sync configured and groups not disabled for this page load. */
  readonly enabled: boolean;
  readonly connection: ConnectionState;
  readonly group: GroupState | null;
  /** A create, join or QR join call is in flight. */
  readonly joining: boolean;
  /** A stored group is being resumed (page load, not settled yet). */
  readonly resuming: boolean;
  /** This tab still has a group pointer. */
  readonly hasPointer: boolean;
  /** The content check for the current membership, or `null` before it ran. */
  readonly compare: CompareResult | null;
  /** The version warning was acknowledged for this leader's text. */
  readonly acknowledged: boolean;
}

/** Fatal codes that are not "update required": the group stays stored. */
function isDisconnected(connection: ConnectionState): boolean {
  if (connection.status !== 'closed') return false;
  if (connection.reason === 'gave_up') return true;
  if (connection.reason !== 'fatal') return false;
  const code = connection.error?.code;
  return (
    code !== 'APP_VERSION_TOO_OLD' && code !== 'PROTOCOL_TOO_OLD' && code !== 'SERVER_UNSUPPORTED'
  );
}

export function derivePhase(input: PhaseInput): Phase {
  const { connection, group } = input;
  if (!input.enabled) return 'off';
  if (group?.status === 'awaiting_approval') return 'awaiting';
  if (input.joining) return 'joining';
  const inGroup =
    group !== null &&
    (group.status === 'active' || group.status === 'rejoining' || group.status === 'waiting');
  if ((inGroup || input.hasPointer) && isDisconnected(connection)) return 'disconnected';
  if (inGroup) {
    if (group.role === 'leader') return 'leader';
    if (group.status === 'waiting') return 'member';
    if (input.compare === null) return group.status === 'rejoining' ? 'member' : 'checking';
    if (input.compare === 'different-content' || input.compare === 'unsupported-schema') {
      return 'mismatch-block';
    }
    if (input.compare === 'different-version' && !input.acknowledged) return 'mismatch-warn';
    return 'member';
  }
  if (input.resuming) return 'resuming';
  return 'solo';
}

/** What the Group button shows (design 5.2). */
export type IndicatorKind =
  | 'group'
  | 'following'
  | 'not-following'
  | 'leading'
  | 'reconnecting'
  | 'leader-offline'
  | 'leader-grace'
  | 'awaiting'
  | 'joining'
  | 'disconnected';

/**
 * The indicator for a phase. Members take the client's indicator
 * (`indicatorOf`); a following member who is browsing shows **Not
 * following** (AC31). `null` hides the Group button (`off`).
 */
export function indicatorFor(
  phase: Phase,
  client: SyncIndicator,
  mode: FollowMode,
): IndicatorKind | null {
  switch (phase) {
    case 'off':
      return null;
    case 'solo':
      return 'group';
    case 'joining':
      return 'joining';
    case 'awaiting':
      return 'awaiting';
    case 'resuming':
    case 'checking':
      return 'reconnecting';
    case 'mismatch-block':
    case 'mismatch-warn':
      return 'not-following';
    case 'disconnected':
      return 'disconnected';
    case 'leader':
      return client === 'reconnecting' ? 'reconnecting' : 'leading';
    case 'member':
      switch (client) {
        case 'following':
          return mode === 'browsing' ? 'not-following' : 'following';
        case 'leader_offline':
          return 'leader-offline';
        case 'leader_grace':
          return 'leader-grace';
        default:
          return 'reconnecting';
      }
  }
}
