import type { ClientErrorCode, SyncClientError } from './errors.js';
import type { GroupState, JoinedGroup } from './state.js';

export type RejoinOutcome =
  | { kind: 'rejoined'; joined: JoinedGroup }
  /** The server refused or did not answer: the group is gone for this client. */
  | { kind: 'failed'; code: ClientErrorCode }
  /** The connection dropped again before an answer; the next reconnect retries. */
  | { kind: 'lost' };

export interface RejoinContext {
  readonly group: GroupState | null;
  /** Sends `group.join` through the normal request path. */
  join(
    groupId: string,
    callbacks: { resolve(joined: JoinedGroup): void; reject(error: SyncClientError): void },
  ): void;
}

/**
 * How the client gets back into its group after a reconnect (internal seam).
 * Item 3 replaces the strategy below with token-based rejoin.
 */
export interface RejoinStrategy {
  /** The group state right after an unexpected drop. */
  onDisconnected(group: GroupState | null): GroupState | null;
  /** Runs after every `hello.ok`; calls `done` once if it started a rejoin. */
  onReady(context: RejoinContext, done: (outcome: RejoinOutcome) => void): void;
}

/**
 * Gate 1 Q1: a member re-sends `group.join` for its last group ID after a
 * reconnect. A leader is never rejoined: the server ended its group when
 * its socket closed.
 */
export const memberRejoinByGroupId: RejoinStrategy = {
  onDisconnected(group) {
    if (group?.status !== 'active') return group;
    if (group.role === 'leader') {
      return { status: 'ended', groupId: group.groupId, reason: 'leader_disconnected' };
    }
    return {
      status: 'rejoining',
      groupId: group.groupId,
      role: 'member',
      metadata: group.metadata ?? {},
      hasPosition: group.hasPosition,
      position: group.position,
    };
  },

  onReady(context, done) {
    const group = context.group;
    if (group?.status !== 'rejoining') return;
    context.join(group.groupId, {
      resolve: (joined) => done({ kind: 'rejoined', joined }),
      reject: (error) => {
        const lost =
          error.source === 'client' &&
          (error.code === 'CONNECTION_LOST' || error.code === 'CLOSED');
        done(lost ? { kind: 'lost' } : { kind: 'failed', code: error.code });
      },
    });
  },
};
