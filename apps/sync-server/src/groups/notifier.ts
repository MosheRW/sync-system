import type { ServerMessage } from '@sync-system/protocol';
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
}

export class LocalNotifier implements Notifier {
  private readonly sessions = new Map<string, Session>();

  /** Number of attachments. For tests only. */
  get size(): number {
    return this.sessions.size;
  }

  register(key: string, session: Session): void {
    this.sessions.set(key, session);
  }

  unregister(key: string, session: Session): boolean {
    if (this.sessions.get(key) !== session) return false;
    this.sessions.delete(key);
    return true;
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
