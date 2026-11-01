import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/apps/app-registry.js';
import { LocalNotifier } from '../src/groups/notifier.js';
import { type Session, membershipKey } from '../src/groups/session.js';

function session(id: string): Session & { received: string[] } {
  const received: string[] = [];
  return {
    connectionId: id,
    app: { namespace: 'app-a' } as AppConfig,
    membership: undefined,
    received,
    deliver: (text) => received.push(text),
    afterPending: (task) => task(),
  };
}

describe('LocalNotifier (membership keys, M4)', () => {
  it('keys attachments by namespace, group and group-scoped participant', () => {
    expect(membershipKey('app-a', 'g', 'p')).toBe('app-a:g:p');
  });

  it('replaces the owner on register and detaches only for the current owner', () => {
    const notifier = new LocalNotifier();
    const older = session('a');
    const newer = session('b');
    notifier.register('k', older);
    notifier.register('k', newer);
    expect(notifier.get('k')).toBe(newer);
    expect(notifier.unregister('k', older)).toBe(false);
    expect(notifier.get('k')).toBe(newer);
    expect(notifier.unregister('k', newer)).toBe(true);
    expect(notifier.get('k')).toBeUndefined();
    expect(notifier.size).toBe(0);
  });

  it('broadcasts one serialized frame to attached keys only', () => {
    const notifier = new LocalNotifier();
    const a = session('a');
    const b = session('b');
    notifier.register('k1', a);
    notifier.register('k2', b);
    notifier.broadcast(['k1', 'k2', 'missing'], { type: 'position.ack' });
    expect(a.received).toEqual(['{"type":"position.ack"}']);
    expect(b.received).toEqual(['{"type":"position.ack"}']);
  });
});
