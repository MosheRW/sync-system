import {
  type JoinedGroup,
  SyncClientError,
  useConnection,
  useGroupExit,
  useJoinByQr,
  useStoredGroups,
} from '@sync-system/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GroupEnv } from './context.js';

export type QrLandingState =
  | { readonly status: 'none' }
  /** The tab already has a group: ask once before anything (security L3). */
  | { readonly status: 'ask'; readonly pending: boolean }
  | { readonly status: 'joining' }
  | { readonly status: 'failed'; readonly error: SyncClientError };

export interface QrLandingFlow {
  readonly state: QrLandingState;
  /** "Join this group": leave the stored group first (never silently), then join. */
  readonly switchGroup: () => void;
  /** "Stay in my group": the ticket is dropped and the stored group resumes. */
  readonly stay: () => void;
  /** The failure was shown; nothing more to do. */
  readonly dismiss: () => void;
}

/**
 * A page load that arrived with a QR ticket (#24 AC17, design F5, R3, L3).
 * The ticket is used for one `joinByQr` once connected and then dropped; a
 * malformed one fails at once with `QR_INVALID`. In a tab that already has
 * a group pointer, the resume waits and the user is asked once; two flows
 * never run at once and no group is left without that answer.
 */
export function useQrLanding(
  env: GroupEnv,
  onAdmitted: (group: JoinedGroup) => void,
): QrLandingFlow {
  const connection = useConnection();
  const joinByQr = useJoinByQr();
  const stored = useStoredGroups();
  const exit = useGroupExit();
  const ticket = useRef<string | null>(env.landing?.kind === 'ticket' ? env.landing.ticket : null);
  const [state, setState] = useState<QrLandingState>(() => {
    if (env.landing === null) return { status: 'none' };
    if (env.landing.kind === 'invalid') {
      return { status: 'failed', error: new SyncClientError('QR_INVALID') };
    }
    return env.pointers.read() !== null ? { status: 'ask', pending: false } : { status: 'joining' };
  });

  const connected = connection.status === 'connected';
  useEffect(() => {
    if (state.status !== 'joining' || !connected) return;
    const value = ticket.current;
    if (value === null) return;
    // Used once, then gone from memory.
    ticket.current = null;
    void joinByQr.run(value).then((result) => {
      if (result.ok) {
        setState({ status: 'none' });
        onAdmitted(result.value);
      } else {
        setState({ status: 'failed', error: result.error });
      }
    });
  }, [state.status, connected, joinByQr, onAdmitted]);

  const switchGroup = useCallback(() => {
    const pointer = env.pointers.read();
    setState({ status: 'ask', pending: true });
    void (async () => {
      if (pointer !== null) {
        const resumed = await stored.resume.run(pointer.groupId);
        if (resumed.ok) {
          // The user chose to leave; a leader can only end the group.
          await (resumed.value.role === 'leader' ? exit.end.run() : exit.leave.run());
        }
        env.pointers.forget();
      }
      setState({ status: 'joining' });
    })();
  }, [env.pointers, stored.resume, exit.end, exit.leave]);

  const stay = useCallback(() => {
    ticket.current = null;
    setState({ status: 'none' });
  }, []);

  const dismiss = useCallback(() => setState({ status: 'none' }), []);

  return { state, switchGroup, stay, dismiss };
}
