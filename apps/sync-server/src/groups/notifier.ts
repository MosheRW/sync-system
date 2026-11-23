import type { ServerMessage } from '@mosherw/sync-system-protocol';
import type { Session } from './session.js';

/**
 * Delivers events to group members, keyed by membership
 * (`namespace:groupId:participantId`, see `membershipKey`). The attachment map
 * is the source of truth for which session owns a membership (M4). Local
 * fan-out now; a pub/sub implementation can replace it for multiple
 * instances later.
 */
export interface Notifier {
  /** Attaches `session` as the owner of `key`, replacing any previous owner. */
  register(key: string, session: Session): void;
  /** Detaches `key` only if `session` still owns it. Returns whether it did. */
  unregister(key: string, session: Session): boolean;
  get(key: string): Session | undefined;
  /** Serializes `message` once and delivers the same string to each attached key. */
  broadcast(keys: readonly string[], message: ServerMessage): void;
  /** Every session attached to the group (#35 ADR 0014: closed when its commit fails). */
  sessionsOf(namespace: string, groupId: string): Session[];
}

/** The group part of a membership key `namespace:groupId:participantId`. */
function groupPart(key: string): string {
  return key.slice(0, key.lastIndexOf(':'));
}

export class LocalNotifier implements Notifier {
  private readonly sessions = new Map<string, Session>();
  /** `namespace:groupId` -> membership keys attached locally. */
  private readonly groups = new Map<string, Set<string>>();

  /** Number of attachments. For tests only. */
  get size(): number {
    return this.sessions.size;
  }

  register(key: string, session: Session): void {
    this.sessions.set(key, session);
    const group = groupPart(key);
    let keys = this.groups.get(group);
    if (keys === undefined) {
      keys = new Set();
      this.groups.set(group, keys);
    }
    keys.add(key);
  }

  unregister(key: string, session: Session): boolean {
    if (this.sessions.get(key) !== session) return false;
    this.sessions.delete(key);
    const group = groupPart(key);
    const keys = this.groups.get(group);
    keys?.delete(key);
    if (keys?.size === 0) this.groups.delete(group);
    return true;
  }

  sessionsOf(namespace: string, groupId: string): Session[] {
    const keys = this.groups.get(`${namespace}:${groupId}`);
    if (keys === undefined) return [];
    return [...keys].map((key) => this.sessions.get(key)).filter((s) => s !== undefined);
  }

  get(key: string): Session | undefined {
    return this.sessions.get(key);
  }

  broadcast(keys: readonly string[], message: ServerMessage): void {
    if (keys.length === 0) return;
    const text = JSON.stringify(message);
    for (const key of keys) {
      this.sessions.get(key)?.deliver(text);
    }
  }
}
