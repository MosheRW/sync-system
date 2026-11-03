import type { ClientErrorCode, SyncClientError } from './errors.js';
import type { GroupState, ResumedGroup } from './state.js';

export type RejoinOutcome =
  | { kind: 'rejoined'; resumed: ResumedGroup }
  /** A member parked until its leader recreates the group. */
  | { kind: 'waiting' }
  /** The server refused, or there was no token: the group is gone for this client. */
  | { kind: 'failed'; code: ClientErrorCode }
  /** The connection dropped or the request timed out; the next reconnect retries. */
  | { kind: 'lost' };

export interface RejoinContext {
  readonly group: GroupState | null;
  /** Sends `group.resume` with the stored token through the normal request path. */
  resume(
    groupId: string,
    callbacks: { resolve(resumed: ResumedGroup): void; reject(error: SyncClientError): void },
  ): void;
}

/** How the client gets back into its group after a reconnect (internal seam). */
export interface RejoinStrategy {
  /** The group state right after an unexpected drop. */
  onDisconnected(group: GroupState | null): GroupState | null;
  /** Runs after every `hello.ok`; calls `done` once if it started a rejoin. */
  onReady(context: RejoinContext, done: (outcome: RejoinOutcome) => void): void;
}

/**
 * #5 AC35 (replaces #3's group-ID rejoin): after an unexpected drop, leader
 * and member both resume with their stored token. The group is `rejoining`
 * at the drop (role, metadata and position kept). A `replaced` or otherwise
 * ended group is never resumed automatically (L6).
 */
export const tokenRejoin: RejoinStrategy = {
  onDisconnected(group) {
    // A pending join request is lost with the connection; no re-request (#10 Q6.3).
    if (group?.status === 'awaiting_approval') return null;
    if (group?.status === 'active') {
      return {
        status: 'rejoining',
        groupId: group.groupId,
        role: group.role,
        metadata: group.metadata,
        hasPosition: group.hasPosition,
        position: group.position,
      };
    }
    if (group?.status === 'waiting') {
      return {
        status: 'rejoining',
        groupId: group.groupId,
        role: 'member',
        metadata: null,
        hasPosition: false,
        position: undefined,
      };
    }
    return group;
  },

  onReady(context, done) {
    const group = context.group;
    if (group?.status !== 'rejoining') return;
    context.resume(group.groupId, {
      resolve: (resumed) =>
        done(resumed.status === 'waiting' ? { kind: 'waiting' } : { kind: 'rejoined', resumed }),
      reject: (error) => {
        // A client-side timeout is not a server refusal: the socket is dropped
        // right after it (timeoutKind 'drop'), so the next reconnect retries.
        const lost =
          error.source === 'client' &&
          (error.code === 'CONNECTION_LOST' ||
            error.code === 'CLOSED' ||
            error.code === 'REQUEST_TIMEOUT');
        done(lost ? { kind: 'lost' } : { kind: 'failed', code: error.code });
      },
    });
  },
};
