import { afterEach, describe, expect, it, vi } from 'vitest';
import { stripLaterTickets } from '../src/group/deep-link.js';
import { createPastedLinkSignal } from '../src/group/pasted-link.js';

const TICKET = `eyJnIjoxfQ.${'s'.repeat(43)}`;

afterEach(() => {
  history.replaceState(null, '', '/');
});

function paste(hash: string) {
  history.replaceState(null, '', `/?book=x${hash}`);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

describe('a pasted QR link (#25 AC57, R20)', () => {
  it('strips first, then calls onIgnored with no arguments', () => {
    const seen: { hash: string; args: number }[] = [];
    const stop = stripLaterTickets(window, (...args: unknown[]) => {
      seen.push({ hash: location.hash, args: args.length });
    });
    paste(`#t=${TICKET}`);
    expect(seen).toEqual([{ hash: '', args: 0 }]);
    expect(location.href).not.toContain(TICKET);
    paste('#t=not-a-ticket');
    expect(seen).toHaveLength(2);
    stop();
  });

  it('ignores fragments that are not tickets', () => {
    const onIgnored = vi.fn();
    const stop = stripLaterTickets(window, onIgnored);
    paste('#chapter-2');
    expect(onIgnored).not.toHaveBeenCalled();
    expect(location.hash).toBe('#chapter-2');
    stop();
  });

  it('a throwing listener does not stop the strip', () => {
    const stop = stripLaterTickets(window, () => {
      throw new Error('listener');
    });
    expect(() => paste(`#t=${TICKET}`)).not.toThrow();
    expect(location.hash).toBe('');
    stop();
  });

  it('the signal is a counter only; take() is true once per new paste', () => {
    const signal = createPastedLinkSignal();
    const listener = vi.fn();
    const off = signal.subscribe(listener);
    expect(signal.take()).toBe(false);
    signal.notify();
    signal.notify();
    expect(signal.count()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(signal.take()).toBe(true);
    expect(signal.take()).toBe(false);
    off();
    signal.notify();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(Object.keys(signal).sort()).toEqual(['count', 'notify', 'subscribe', 'take']);
  });
});
