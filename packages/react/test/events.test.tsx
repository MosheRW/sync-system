import type { ConnectionState } from '@sync-system/client';
import { act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useSyncEvent } from '../src/hooks/events.js';
import { FakeSyncClient } from './helpers/fake-client.js';
import { renderWithProvider } from './helpers/render.js';

describe('useSyncEvent (AC25)', () => {
  it('calls the latest handler with one subscription, and unsubscribes on unmount', () => {
    const client = new FakeSyncClient();
    const seen: string[] = [];
    function Probe({ tag }: { tag: string }): ReactNode {
      useSyncEvent('positionUpdated', (event) =>
        seen.push(`${tag}:${JSON.stringify(event.position)}`),
      );
      return null;
    }
    const before = client.listenerCount('positionUpdated');
    const view = renderWithProvider(<Probe tag="a" />, { client });
    // The store itself does not listen to positionUpdated: one subscription is ours.
    expect(client.listenerCount('positionUpdated')).toBe(before + 1);
    act(() => client.emit('positionUpdated', { groupId: 'g-1', position: 1 }));
    view.rerenderWith(<Probe tag="b" />, { client });
    expect(client.listenerCount('positionUpdated')).toBe(before + 1);
    act(() => client.emit('positionUpdated', { groupId: 'g-1', position: 2 }));
    expect(seen).toEqual(['a:1', 'b:2']);
    view.unmount();
    expect(client.listenerCount('positionUpdated')).toBe(0);
  });

  it('does not resubscribe when only the handler changes (strict off)', () => {
    const client = new FakeSyncClient();
    let subscriptions = 0;
    const on = client.on.bind(client);
    client.on = (event: never, listener: never) => {
      subscriptions += 1;
      return on(event, listener);
    };
    const states: ConnectionState[] = [];
    function Probe({ n }: { n: number }): ReactNode {
      useSyncEvent('state', (state) => {
        if (n >= 0) states.push(state);
      });
      return null;
    }
    const view = renderWithProvider(<Probe n={0} />, { client, strict: false });
    const afterMount = subscriptions;
    for (let n = 1; n < 10; n += 1) view.rerenderWith(<Probe n={n} />, { client, strict: false });
    expect(subscriptions).toBe(afterMount);
  });
});
