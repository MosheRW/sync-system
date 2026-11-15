/**
 * An effect of a group task on a participant attached to another instance
 * (#35 architecture 12.7, ADR 0012): sent over that instance's pub/sub
 * channel inside the task's commit and applied there only to a matching
 * local session (security P2-4). Frames travel serialized.
 */
export type RemoteEffect =
  /** Deliver a frame to the session attached as `pid` with attach ID `att`. */
  | {
      op: 'deliver';
      ns: string;
      gid: string;
      pid: string;
      att: string;
      text: string;
      later: boolean;
    }
  /** The session loses its membership, then gets `text` and a close with `close`. */
  | {
      op: 'detach';
      ns: string;
      gid: string;
      pid: string;
      att: string;
      reason: 'replaced' | 'removed' | 'ended';
      text?: string;
      close?: 4004;
    }
  /** An approved joiner waiting on `rid` is attached as `pid` with `att` (12.9). */
  | { op: 'admit'; ns: string; gid: string; pid: string; att: string; rid: string; text: string }
  /** A joiner waiting on `rid` gets its outcome (deny, timeout, group gone). */
  | { op: 'settle'; ns: string; gid: string; rid: string; text: string }
  /** Start the leader token refresher for `pid` there. */
  | { op: 'refresh'; ns: string; gid: string; pid: string; att: string; at: number }
  /** The group was recreated: admit the members parked there (12.10). */
  | { op: 'admitParked'; ns: string; gid: string }
  /** The group ended: drop local per-group state. */
  | { op: 'forget'; ns: string; gid: string };
