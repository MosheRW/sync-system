import type { RemoteEffect } from './remote-effects.js';
import type { Session } from './session.js';

/** Why a participant's session loses its membership. */
export type DetachReason = 'replaced' | 'removed' | 'ended';

/**
 * A participant as a group task reaches it (#35 architecture 12.6): an
 * attached session on this instance, or, with several instances, the
 * instance its session is attached to. Every frame and every detach of a
 * group task goes through one, so the task never needs to know where the
 * participant is.
 */
export interface Recipient {
  /** The group-scoped participant ID. */
  readonly pid: string;
  /** Local: the socket is open. Remote: its instance looks alive (a hint). */
  isOpen(): boolean;
  /**
   * Sends a serialized frame after the task's commit; `later` = after the
   * replies the session is already owed (`afterPending`).
   */
  send(text: string, later: boolean): void;
  /**
   * The session loses the membership now (M4) and, after its pending
   * replies, gets `text` (if any) and then a close with `close` (if any).
   */
  detach(reason: DetachReason, text?: string, close?: number): void;
  /** Starts the leader token refresher where this participant is (#5 AC12). */
  refresh(at: number): void;
}

/** Where a frame can go: a recipient, or the requesting session itself. */
export type Target = Recipient | Session;

/** True when `target` is a recipient rather than a bare session. */
export function isRecipient(target: Target): target is Recipient {
  return 'send' in target;
}

/** What a local recipient needs from the group service. */
export interface LocalRecipientHost {
  /** Queues `effect` in the running task's outbox, or runs it now. */
  effect(effect: () => void): void;
  /** Detaches `session` from the membership `pid` of `groupId` (unregister, rollback record). */
  detachLocal(session: Session, groupId: string, pid: string): void;
  /** Starts the refresher of the group on this instance. */
  refreshLocal(groupId: string, at: number): void;
}

/**
 * A session attached on this instance. Wraps exactly what the group service
 * did with the session before recipients existed, so memory mode keeps its
 * per-socket order (#35 AC1).
 */
export class LocalRecipient implements Recipient {
  constructor(
    readonly session: Session,
    readonly groupId: string,
    readonly pid: string,
    private readonly host: LocalRecipientHost,
  ) {}

  isOpen(): boolean {
    return this.session.isOpen();
  }

  send(text: string, later: boolean): void {
    const { session } = this;
    if (later) this.host.effect(() => session.afterPending(() => session.deliver(text)));
    else this.host.effect(() => session.deliver(text));
  }

  detach(_reason: DetachReason, text?: string, close?: number): void {
    const { session } = this;
    this.host.detachLocal(session, this.groupId, this.pid);
    if (text === undefined && close === undefined) return;
    this.host.effect(() =>
      session.afterPending(() => {
        if (text !== undefined) session.deliver(text);
        if (close !== undefined) session.close(close, 'removed');
      }),
    );
  }

  refresh(at: number): void {
    this.host.refreshLocal(this.groupId, at);
  }
}

/** What a remote recipient needs (#35 architecture 12.6, 12.7). */
export interface RemoteRecipientHost {
  /** Sends `effect` to the participant's instance with the task's commit. */
  send(instance: string, effect: RemoteEffect): void;
  /** The registry entry `attachId` of `pid` goes (in the task's commit). */
  forget(pid: string, attachId: string): void;
  /** Whether the instance looked alive at the last renewal (a hint). */
  looksLive(instance: string): boolean;
}

/**
 * A participant attached to another instance (#35 architecture 12.6):
 * every frame and detach becomes a remote effect for that instance, sent in
 * the task's commit, applied there only to the session with this attach ID.
 */
export class RemoteRecipient implements Recipient {
  constructor(
    readonly namespace: string,
    readonly groupId: string,
    readonly pid: string,
    readonly instance: string,
    readonly attachId: string,
    private readonly host: RemoteRecipientHost,
  ) {}

  isOpen(): boolean {
    return this.host.looksLive(this.instance);
  }

  send(text: string, later: boolean): void {
    this.host.send(this.instance, {
      op: 'deliver',
      ns: this.namespace,
      gid: this.groupId,
      pid: this.pid,
      att: this.attachId,
      text,
      later,
    });
  }

  detach(reason: DetachReason, text?: string, close?: number): void {
    this.host.forget(this.pid, this.attachId);
    this.host.send(this.instance, {
      op: 'detach',
      ns: this.namespace,
      gid: this.groupId,
      pid: this.pid,
      att: this.attachId,
      reason,
      ...(text === undefined ? {} : { text }),
      ...(close === 4004 ? { close: 4004 as const } : {}),
    });
  }

  refresh(at: number): void {
    this.host.send(this.instance, {
      op: 'refresh',
      ns: this.namespace,
      gid: this.groupId,
      pid: this.pid,
      att: this.attachId,
      at,
    });
  }
}
