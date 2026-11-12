import { describe, expect, it } from 'vitest';
import { LocalRecipient, isRecipient } from '../src/groups/recipients.js';
import type { Session } from '../src/groups/session.js';

/** A session that records what happens to it, with `afterPending` run at `drain()`. */
function recordingSession() {
  const log: string[] = [];
  const pending: Array<() => void> = [];
  const session = {
    membership: { groupId: 'g', participantId: 'p', attachId: 'a' },
    isOpen: () => true,
    deliver: (text: string) => log.push(`deliver ${text}`),
    close: (code: number) => log.push(`close ${code}`),
    afterPending: (task: () => void) => pending.push(task),
  } as unknown as Session;
  return {
    session,
    log,
    drain: () => {
      for (const task of pending.splice(0)) task();
    },
  };
}

describe('LocalRecipient (#35 architecture 12.6, AC1)', () => {
  it('sends now or after pending replies, through the outbox', () => {
    const { session, log, drain } = recordingSession();
    const outbox: Array<() => void> = [];
    const recipient = new LocalRecipient(session, 'g', 'p', {
      effect: (effect) => outbox.push(effect),
      detachLocal: () => undefined,
      refreshLocal: () => undefined,
    });
    recipient.send('one', false);
    recipient.send('two', true);
    expect(log).toEqual([]);
    for (const effect of outbox) effect();
    expect(log).toEqual(['deliver one']);
    drain();
    expect(log).toEqual(['deliver one', 'deliver two']);
  });

  it('detaches at once, then delivers the last frame and closes after pending replies', () => {
    const { session, log, drain } = recordingSession();
    const outbox: Array<() => void> = [];
    const detached: string[] = [];
    const recipient = new LocalRecipient(session, 'g', 'p', {
      effect: (effect) => outbox.push(effect),
      detachLocal: (_s, groupId, pid) => detached.push(`${groupId}:${pid}`),
      refreshLocal: () => undefined,
    });
    recipient.detach('removed', 'bye', 4004);
    expect(detached).toEqual(['g:p']);
    for (const effect of outbox) effect();
    expect(log).toEqual([]);
    drain();
    expect(log).toEqual(['deliver bye', 'close 4004']);
  });

  it('queues nothing for a detach without frame or close (the requester of an end)', () => {
    const { session } = recordingSession();
    const outbox: Array<() => void> = [];
    const recipient = new LocalRecipient(session, 'g', 'p', {
      effect: (effect) => outbox.push(effect),
      detachLocal: () => undefined,
      refreshLocal: () => undefined,
    });
    recipient.detach('ended');
    expect(outbox).toEqual([]);
  });

  it('starts the refresher on this instance, and tells recipients from sessions', () => {
    const { session } = recordingSession();
    const refreshed: number[] = [];
    const recipient = new LocalRecipient(session, 'g', 'p', {
      effect: () => undefined,
      detachLocal: () => undefined,
      refreshLocal: (_gid, at) => refreshed.push(at),
    });
    recipient.refresh(42);
    expect(refreshed).toEqual([42]);
    expect(isRecipient(recipient)).toBe(true);
    expect(isRecipient(session)).toBe(false);
  });
});
