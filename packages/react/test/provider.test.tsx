import type { SyncClientOptions } from '@sync-system/client';
import { SyncClient } from '@sync-system/client';
import { act, render } from '@testing-library/react';
import { type ReactNode, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSyncStore } from '../src/context.js';
import { SyncProvider, type SyncProviderProps } from '../src/provider.js';
import type { SyncStore } from '../src/store.js';
import { FakeSyncClient } from './helpers/fake-client.js';
import { CountingWebSocket } from './helpers/fake-websocket.js';
import { renderWithProvider } from './helpers/render.js';

/** Obviously fake test values (R14). */
const OPTIONS: SyncClientOptions = {
  url: 'wss://sync.example.test/ws',
  apiKey: 'test-key-react-provider-0123456789-abcdef',
  appVersion: '1.0.0',
  WebSocket: CountingWebSocket,
  storage: 'memory',
};

let seen: SyncStore[] = [];

function Probe(): ReactNode {
  seen.push(useSyncStore('Probe'));
  return null;
}

const tick = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));

beforeEach(() => {
  seen = [];
  CountingWebSocket.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('client mode (AC4)', () => {
  it('uses the given client and never closes it', async () => {
    const client = new FakeSyncClient();
    const view = renderWithProvider(<Probe />, { client });
    expect(seen.at(-1)?.client).toBe(client);
    view.unmount();
    await tick();
    expect(client.count('close')).toBe(0);
  });

  it('connects once from idle, under StrictMode (D4)', () => {
    const client = new FakeSyncClient();
    renderWithProvider(<Probe />, { client });
    expect(client.count('connect')).toBe(1);
  });

  it('does not connect a client that is not idle', () => {
    const client = new FakeSyncClient();
    client.setConnection({ status: 'connecting' });
    renderWithProvider(<Probe />, { client });
    expect(client.count('connect')).toBe(0);
  });

  it('autoConnect={false} does not connect; turning it on connects from idle only', () => {
    const client = new FakeSyncClient();
    const view = renderWithProvider(<Probe />, { client, autoConnect: false });
    expect(client.count('connect')).toBe(0);
    view.rerenderWith(<Probe />, { client, autoConnect: true });
    expect(client.count('connect')).toBe(1);
  });

  it('a rejected connect() causes no unhandled rejection', async () => {
    const client = new FakeSyncClient();
    client.impl.connect = () => Promise.reject(new Error('refused'));
    renderWithProvider(<Probe />, { client });
    await tick();
    expect(client.count('connect')).toBe(1);
  });
});

describe('owned mode (AC5, AC6)', () => {
  it('creates no client during render, then one client and one socket after mount', () => {
    const construct = vi.spyOn(SyncClient.prototype, 'connect');
    let storesDuringFirstRender: SyncStore | undefined;
    function First(): ReactNode {
      const store = useSyncStore('First');
      storesDuringFirstRender ??= store;
      return null;
    }
    renderWithProvider(<First />, { options: OPTIONS });
    expect(storesDuringFirstRender?.client).toBeNull();
    expect(construct).toHaveBeenCalledTimes(1);
    expect(CountingWebSocket.instances).toHaveLength(1);
    expect(CountingWebSocket.closed).toBe(0);
  });

  it('StrictMode plus 20 re-renders with new option objects keep one client and one socket', async () => {
    const view = renderWithProvider(<Probe />, { options: OPTIONS });
    for (let i = 0; i < 20; i += 1) {
      view.rerenderWith(<Probe />, { options: { ...OPTIONS, appVersion: `1.0.${i}` } });
    }
    await tick();
    const clients = new Set(seen.map((store) => store.client).filter((c) => c !== null));
    expect(clients.size).toBe(1);
    expect(CountingWebSocket.instances).toHaveLength(1);
    expect(CountingWebSocket.closed).toBe(0);
    const [client] = [...clients];
    expect(client?.getState().status).toBe('connecting');
  });

  it('closes the owned client once, one tick after a real unmount', async () => {
    const view = renderWithProvider(<Probe />, { options: OPTIONS });
    const client = seen.at(-1)?.client;
    const close = vi.spyOn(client as SyncClient, 'close');
    view.unmount();
    expect(close).not.toHaveBeenCalled();
    await tick();
    expect(close).toHaveBeenCalledTimes(1);
    expect(CountingWebSocket.closed).toBe(1);
    expect(client?.getState()).toEqual({ status: 'closed', reason: 'client' });
  });

  it('a remount after a real close creates a fresh client', async () => {
    const first = renderWithProvider(<Probe />, { options: OPTIONS });
    const a = seen.at(-1)?.client;
    first.unmount();
    await tick();
    renderWithProvider(<Probe />, { options: OPTIONS });
    const b = seen.at(-1)?.client;
    expect(b).not.toBeNull();
    expect(b).not.toBe(a);
    expect(b?.getState().status).toBe('connecting');
    expect(CountingWebSocket.instances).toHaveLength(2);
  });

  it('autoConnect={false} opens no socket until the app connects', async () => {
    renderWithProvider(<Probe />, { options: OPTIONS, autoConnect: false });
    const client = seen.at(-1)?.client;
    expect(client).not.toBeNull();
    expect(CountingWebSocket.instances).toHaveLength(0);
    await act(async () => {
      client?.connect().catch(() => undefined);
      await Promise.resolve();
    });
    expect(CountingWebSocket.instances).toHaveLength(1);
  });

  it('invalid options give a closed, fatal INVALID_OPTIONS state and no retry', async () => {
    vi.useFakeTimers();
    try {
      renderWithProvider(<Probe />, { options: { ...OPTIONS, url: 'not a url' } });
      const store = seen.at(-1)!;
      expect(store.client).toBeNull();
      const connection = store.getState().snapshot.connection;
      expect(connection.status === 'closed' && connection.error?.code).toBe('INVALID_OPTIONS');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60_000);
      });
      expect(CountingWebSocket.instances).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('props (AC4)', () => {
  it('throws a fixed error for both or neither of options and client', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const both = { options: OPTIONS, client: new FakeSyncClient() } as unknown as SyncProviderProps;
    expect(() => render(<SyncProvider {...both} />)).toThrow(
      '<SyncProvider> needs exactly one of the options or client props (@sync-system/react)',
    );
    expect(() => render(<SyncProvider {...({} as SyncProviderProps)} />)).toThrow(/exactly one/);
  });

  it('throws when switching between options and client on one mount', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const client = new FakeSyncClient();
    const view = render(
      <StrictMode>
        <SyncProvider client={client} />
      </StrictMode>,
    );
    expect(() =>
      view.rerender(
        <StrictMode>
          <SyncProvider options={OPTIONS} />
        </StrictMode>,
      ),
    ).toThrow(/cannot switch/);
  });
});
