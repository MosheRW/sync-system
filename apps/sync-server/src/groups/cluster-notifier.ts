import type { AttachmentRegistry } from '../storage/redis/attachments.js';
import type { Notifier } from './notifier.js';
import type { RemoteEffect } from './remote-effects.js';
import { type Session, membershipKey } from './session.js';

/** What the cluster resolution needs from the Redis storage (#35 architecture 12.6). */
export interface ClusterHost {
  /** The instance ID the running task acts as (else the current one). */
  selfId(): string | undefined;
  /** The group's registry as the running task read it; undefined outside such a task. */
  registry(namespace: string, groupId: string): AttachmentRegistry | undefined;
  /** Whether instance `id` looked alive at the last renewal (a hint, security C12). */
  looksLive(id: string): boolean;
  /** Sends `effect` to `instance`: in the running task's commit, else at once. */
  send(instance: string, effect: RemoteEffect): void;
}

/** Where a participant is attached, as a task sees it. */
export type Resolved =
  { kind: 'local'; session: Session } | { kind: 'remote'; instance: string; attachId: string };

/**
 * Who owns a membership with several instances (#35 architecture 12.6,
 * security C14). Inside a group task, the registry the task read decides:
 * an entry naming this instance resolves to the local session only if its
 * attach ID matches; an entry naming another instance resolves to that
 * instance. A local session the registry no longer names is nobody (M4).
 * Outside a task only local sessions resolve (they may only be denied).
 */
export class ClusterNotifier {
  constructor(
    readonly local: Notifier,
    readonly host: ClusterHost,
  ) {}

  resolve(namespace: string, groupId: string, pid: string): Resolved | undefined {
    const session = this.local.get(membershipKey(namespace, groupId, pid));
    const registry = this.host.registry(namespace, groupId);
    if (registry === undefined)
      return session === undefined ? undefined : { kind: 'local', session };
    const entry = registry.get(pid);
    if (entry === undefined) return undefined;
    if (entry.i === this.host.selfId()) {
      return session !== undefined && session.membership?.attachId === entry.t
        ? { kind: 'local', session }
        : undefined;
    }
    return { kind: 'remote', instance: entry.i, attachId: entry.t };
  }

  /** `session` was attached here as `pid` with attach ID `attachId` (the task's registry). */
  attached(namespace: string, groupId: string, pid: string, attachId: string): void {
    const self = this.host.selfId();
    if (self === undefined) return;
    this.host.registry(namespace, groupId)?.set(pid, { i: self, t: attachId });
  }

  /** The other instances the group's registry named when the task read it. */
  others(namespace: string, groupId: string): string[] {
    const registry = this.host.registry(namespace, groupId);
    if (registry === undefined) return [];
    const self = this.host.selfId();
    return [...new Set([...registry.loaded.values()].map((entry) => entry.i))].filter(
      (id) => id !== self,
    );
  }

  /** The attachment `attachId` of `pid` ends (only while the registry still names it). */
  detached(namespace: string, groupId: string, pid: string, attachId: string | undefined): void {
    if (attachId === undefined) return;
    this.host.registry(namespace, groupId)?.delete(pid, attachId);
  }
}
