import type { SyncClientSnapshot } from '@mosherw/sync-system-client';
import { act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { useSyncSelector, useSyncSnapshot } from '../src/selector.js';
import { CONNECTED, FakeSyncClient } from './helpers/fake-client.js';
import { renderWithProvider } from './helpers/render.js';

function setup<T>(use: () => T): { client: FakeSyncClient; renders: () => number; values: T[] } {
  const client = new FakeSyncClient();
  client.setConnection({ status: 'connecting' });
  const values: T[] = [];
  function Probe(): ReactNode {
    values.push(use());
    return null;
  }
  renderWithProvider(<Probe />, { client, strict: false });
  return { client, renders: () => values.length, values };
}

describe('useSyncSnapshot (AC9)', () => {
  it('returns the core snapshot with its identity', () => {
    const { client, values } = setup(useSyncSnapshot);
    expect(values.at(-1)).toBe(client.snapshot);
    act(() => client.setConnection(CONNECTED));
    expect(values.at(-1)).toBe(client.snapshot);
  });
});

describe('useSyncSelector (AC11)', () => {
  it('does not re-render on an unrelated snapshot change', () => {
    const { client, renders, values } = setup(() =>
      useSyncSelector((s: SyncClientSnapshot) => s.connection.status),
    );
    const before = renders();
    expect(values.at(-1)).toBe('connecting');
    act(() => client.setGroup({ status: 'ended', groupId: 'g-1', reason: 'left' }));
    act(() => client.emit('rosterChanged', { groupId: 'g-1', roster: [] }));
    expect(renders()).toBe(before);
    act(() => client.setConnection(CONNECTED));
    expect(renders()).toBe(before + 1);
    expect(values.at(-1)).toBe('connected');
  });

  it('keeps the identity of an equal selection with a custom isEqual', () => {
    const { client, renders, values } = setup(() =>
      useSyncSelector(
        (s) => ({ connected: s.connection.status === 'connected' }),
        (a, b) => a.connected === b.connected,
      ),
    );
    const first = values.at(-1);
    const before = renders();
    act(() => client.setConnection({ status: 'connecting' }));
    act(() => client.setGroup(null));
    expect(renders()).toBe(before);
    expect(values.at(-1)).toBe(first);
    act(() => client.setConnection(CONNECTED));
    expect(values.at(-1)).toEqual({ connected: true });
    expect(values.at(-1)).not.toBe(first);
  });

  it('an inline selector returning a new object does not loop', () => {
    const { client, renders, values } = setup(() =>
      useSyncSelector((s) => ({ status: s.connection.status })),
    );
    expect(renders()).toBeLessThan(5);
    act(() => client.setConnection(CONNECTED));
    expect(values.at(-1)).toEqual({ status: 'connected' });
    expect(renders()).toBeLessThan(10);
  });
});
