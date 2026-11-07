import {
  type ResumedGroup,
  useConnection,
  useStoredGroups,
  useSyncClient,
} from '@sync-system/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GroupEnv } from './context.js';
import type { GroupPointer } from './session-store.js';

/** Resume failures that mean the stored group is gone: forget it, never retry (AC37). */
const GONE = new Set([
  'TOKEN_NOT_FOUND',
  'TOKEN_INVALID',
  'TOKEN_EXPIRED',
  'GROUP_ENDED',
  'PARTICIPANT_BLOCKED',
  'GROUP_FULL',
]);

/** Network failures: retried, at most this many attempts per page load (AC37). */
export const MAX_RESUME_ATTEMPTS = 3;

export type ResumeStatus = 'none' | 'pending' | 'done' | 'gone' | 'failed';

export interface Resume {
  readonly status: ResumeStatus;
  /** The pointer this page load started with (for the stored follow mode and ack). */
  readonly pointer: GroupPointer | null;
  /** Try again after the attempts ran out (a user action). */
  readonly retry: () => void;
  /** Forget the stored group locally (Leave group while not connected). */
  readonly forget: () => void;
}

/**
 * Comes back to this tab's group after a reload or a reopened tab (#24
 * AC34, AC36, AC37, architecture 8.2): on the first `connected`, one
 * `resumeGroup` with the pointer's group ID. A gone group is forgotten with
 * one notice; network failures are retried at most 3 times, then the user
 * gets Try again and Leave group. Nothing loops on a timer. `enabled` is
 * false while a QR landing is being answered (L3).
 */
export function useResume(
  env: GroupEnv,
  enabled: boolean,
  onResumed: (group: ResumedGroup, pointer: GroupPointer) => void,
): Resume {
  const connection = useConnection();
  const stored = useStoredGroups();
  const client = useSyncClient();
  const [pointer] = useState(() => env.pointers.read());
  const [status, setStatus] = useState<ResumeStatus>(pointer !== null ? 'pending' : 'none');
  const attempts = useRef(0);
  const inFlight = useRef(false);
  const callback = useRef(onResumed);
  callback.current = onResumed;
  const [round, setRound] = useState(0);

  const connected = connection.status === 'connected';
  useEffect(() => {
    if (!enabled || pointer === null || status !== 'pending' || !connected || inFlight.current) {
      return;
    }
    if (env.pointers.read() === null) {
      // Left or replaced meanwhile (a QR switch, another flow).
      setStatus('none');
      return;
    }
    inFlight.current = true;
    attempts.current += 1;
    void stored.resume.run(pointer.groupId).then((result) => {
      inFlight.current = false;
      if (result.ok) {
        setStatus('done');
        callback.current(result.value, pointer);
        return;
      }
      if (GONE.has(result.error.code)) {
        env.pointers.forget();
        setStatus('gone');
        return;
      }
      if (attempts.current >= MAX_RESUME_ATTEMPTS) setStatus('failed');
      else setRound((n) => n + 1);
    });
  }, [enabled, pointer, status, connected, stored.resume, env.pointers, round]);

  const retry = useCallback(() => {
    attempts.current = 0;
    setStatus('pending');
    setRound((n) => n + 1);
    if (connection.status === 'closed') connection.retry();
  }, [connection]);

  const forget = useCallback(() => {
    if (pointer !== null) {
      const local = client as { forgetGroup?: (groupId: string) => Promise<void> } | null;
      void local?.forgetGroup?.(pointer.groupId).catch(() => undefined);
    }
    env.pointers.forget();
    setStatus('none');
  }, [client, env.pointers, pointer]);

  return { status, pointer, retry, forget };
}
