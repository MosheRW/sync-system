import {
  type JoinedGroup,
  type JoinOptions,
  type SyncClientError,
  useConnection,
  useJoinApproval,
  useJoinByCode,
  useSyncClient,
} from '@mosherw/sync-system-react';
import { useCallback, useState } from 'react';
import { type ErrorView, errorView } from './errors.js';

/** A join error to show, with the local time a server wait ends. */
export interface JoinError {
  readonly view: ErrorView;
  /** Local epoch ms (now + the server's `retryAfterMs`), or `null`. */
  readonly retryAt: number | null;
}

export type JoinStep = 'code' | 'door';

export interface Join {
  readonly code: string;
  readonly setCode: (code: string) => void;
  readonly name: string;
  readonly setName: (name: string) => void;
  readonly door: string;
  readonly setDoor: (door: string) => void;
  readonly step: JoinStep;
  readonly backToCode: () => void;
  readonly error: JoinError | null;
  readonly pending: boolean;
  /** `expiresAt` (local epoch ms) while waiting for the leader's approval (method B). */
  readonly waitingUntil: number | null;
  readonly submitCode: (input: { code: string; displayName?: string }) => void;
  readonly submitDoor: (door: string) => void;
  readonly cancelRequest: () => void;
  readonly cancelPending: boolean;
  /** Forget the fields and the error (after admission, leave, or Back). */
  readonly clear: () => void;
}

/**
 * The join-by-code flow (#24 AC14-AC16, AC19, design F2, F3): the code is
 * kept for a retry, `DOOR_CODE_REQUIRED` switches to the door code,
 * `DOOR_CODE_WRONG` clears the door field, a method B request waits for
 * approval (the join call resolves on admission). `onError` is told about
 * every shown error so a closed sheet can reopen (design F3.3).
 */
export function useJoin({
  onAdmitted,
  onError,
}: {
  onAdmitted: (group: JoinedGroup) => void;
  onError: (error: JoinError) => void;
}): Join {
  const joinByCode = useJoinByCode();
  const approval = useJoinApproval();
  const connection = useConnection();
  const client = useSyncClient();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [door, setDoor] = useState('');
  const [displayName, setDisplayName] = useState<string | undefined>(undefined);
  const [step, setStep] = useState<JoinStep>('code');
  const [error, setError] = useState<JoinError | null>(null);

  const clear = useCallback(() => {
    setCode('');
    setName('');
    setDoor('');
    setStep('code');
    setError(null);
  }, []);

  const fail = useCallback(
    (caught: SyncClientError) => {
      if (caught.code === 'DOOR_CODE_REQUIRED') {
        setError(null);
        setStep('door');
        return;
      }
      const view = errorView(caught);
      if (view === null) {
        // JOIN_CANCELLED: back to the code, no message.
        setError(null);
        setStep('code');
        return;
      }
      if (view.focus === 'door') setDoor('');
      const shown: JoinError = {
        view,
        retryAt: view.retryAfterMs !== undefined ? Date.now() + view.retryAfterMs : null,
      };
      setError(shown);
      onError(shown);
    },
    [onError],
  );

  const send = useCallback(
    async (joinCode: string, options: JoinOptions) => {
      setError(null);
      if (connection.status !== 'connected' && client !== null) {
        // A user action: connect first (lazy connect, design F0.3).
        await client.connect().catch(() => undefined);
      }
      const result = await joinByCode.run(joinCode, options);
      if (result.ok) {
        clear();
        onAdmitted(result.value);
      } else {
        fail(result.error);
      }
    },
    [client, connection.status, joinByCode, clear, onAdmitted, fail],
  );

  const submitCode = useCallback(
    (input: { code: string; displayName?: string }) => {
      setDisplayName(input.displayName);
      void send(
        input.code,
        input.displayName !== undefined ? { displayName: input.displayName } : {},
      );
    },
    [send],
  );

  const submitDoor = useCallback(
    (doorCode: string) => {
      void send(code, {
        doorCode,
        ...(displayName !== undefined ? { displayName } : {}),
      });
    },
    [send, code, displayName],
  );

  const flow = approval.flow;
  return {
    code,
    setCode,
    name,
    setName,
    door,
    setDoor,
    step,
    backToCode: () => {
      setStep('code');
      setError(null);
    },
    error,
    pending: joinByCode.pending,
    waitingUntil: flow.status === 'waiting' ? flow.expiresAt : null,
    submitCode,
    submitDoor,
    cancelRequest: () => void approval.cancel.run(),
    cancelPending: approval.cancel.pending,
    clear,
  };
}
