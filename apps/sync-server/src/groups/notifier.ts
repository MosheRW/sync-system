import type { ServerMessage } from '@sync-system/protocol';
import type { Session } from './session.js';

/**
 * Delivers events to participants. Local fan-out now; a pub/sub
 * implementation can replace it for multiple instances later.
 */
export interface Notifier {
  register(session: Session): void;
  unregister(participantId: string): void;
  get(participantId: string): Session | undefined;
  /** Serializes `message` once and delivers the same string to each participant. */
  broadcast(participantIds: readonly string[], message: ServerMessage): void;
}

export class LocalNotifier implements Notifier {
  private readonly sessions = new Map<string, Session>();

  register(session: Session): void {
    this.sessions.set(session.participantId, session);
  }

  unregister(participantId: string): void {
    this.sessions.delete(participantId);
  }

  get(participantId: string): Session | undefined {
    return this.sessions.get(participantId);
  }

  broadcast(participantIds: readonly string[], message: ServerMessage): void {
    if (participantIds.length === 0) return;
    const text = JSON.stringify(message);
    for (const participantId of participantIds) {
      this.sessions.get(participantId)?.deliver(text);
    }
  }
}
