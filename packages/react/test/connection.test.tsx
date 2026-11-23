import {
  type ClosedReason,
  type ConnectionState,
  SyncClientError,
  indicatorOf,
} from '@mosherw/sync-system-client';
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionIndicator } from '../src/components/connection-indicator.js';
import {
  type Connection,
  useConnection,
  useSyncClient,
  useSyncIndicator,
  useUpdateRequired,
} from '../src/hooks/connection.js';
import { SyncProvider } from '../src/provider.js';
import type { SyncClientLike, UpdateRequired } from '../src/types.js';
import { CONNECTED, FakeSyncClient, activeGroup } from './helpers/fake-client.js';
import { renderWithProvider } from './helpers/render.js';

afterEach(() => {
  vi.useRealTimers();
});

function track<T>(use: () => T): { values: T[]; Probe: () => ReactNode } {
  const values: T[] = [];
  return {
    values,
    Probe: () => {
      values.push(use());
      return null;
    },
  };
}

describe('no automatic connect after a fatal close (AC7, AC22, R5)', () => {
  const closedStates: [string, ConnectionState][] = [
    [
      'fatal INVALID_API_KEY',
      {
        status: 'closed',
        reason: 'fatal',
        error: new SyncClientError('INVALID_API_KEY', { fatal: true }),
      },
    ],
    [
      'fatal PROTOCOL_TOO_OLD',
      {
        status: 'closed',
        reason: 'fatal',
        error: new SyncClientError('PROTOCOL_TOO_OLD', { fatal: true }),
      },
    ],
    [
      'fatal APP_VERSION_TOO_OLD',
      {
        status: 'closed',
        reason: 'fatal',
        error: new SyncClientError('APP_VERSION_TOO_OLD', { fatal: true }),
      },
    ],
    [
      'fatal SERVER_UNSUPPORTED',
      {
        status: 'closed',
        reason: 'fatal',
        error: new SyncClientError('SERVER_UNSUPPORTED', { fatal: true }),
      },
    ],
    [
      'removed',
      {
        status: 'closed',
        reason: 'removed',
        error: new SyncClientError('REMOVED', { fatal: true }),
      },
    ],
    [
      'gave_up',
      { status: 'closed', reason: 'gave_up', error: new SyncClientError('RECONNECT_FAILED') },
    ],
    ['client', { status: 'closed', reason: 'client' as ClosedReason }],
  ];

  it.each(closedStates)('%s: re-renders and 10 minutes never connect again', async (_, closed) => {
    vi.useFakeTimers();
    const client = new FakeSyncClient();
    const { Probe, values } = track(useConnection);
    const view = renderWithProvider(<Probe />, { client });
    expect(client.count('connect')).toBe(1);
    act(() => client.setConnection(closed));
    for (let i = 0; i < 20; i += 1) view.rerenderWith(<Probe />, { client });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(client.count('connect')).toBe(1);
    expect(values.at(-1)?.status).toBe('closed');
    // A manual retry goes through the core connect() once.
    act(() => values.at(-1)?.retry());
    expect(client.count('connect')).toBe(2);
  });
});

describe('useConnection (AC13)', () => {
  it('exposes state, status, indicator and keeps its identity', () => {
    const client = new FakeSyncClient();
    const { Probe, values } = track(useConnection);
    const view = renderWithProvider(<Probe />, { client, strict: false });
    act(() => client.follow('g-1'));
    const value = values.at(-1) as Connection;
    expect(value.state).toBe(CONNECTED);
    expect(value.status).toBe('connected');
    expect(value.indicator).toBe(indicatorOf(client.snapshot));
    expect(value.indicator).toBe('following');
    expect(value.retry).toBe(value.connect);
    view.rerenderWith(<Probe />, { client, strict: false });
    expect(values.at(-1)).toBe(value);
  });

  it('lastError follows the error event and clears on connected', () => {
    const client = new FakeSyncClient();
    const { Probe, values } = track(useConnection);
    renderWithProvider(<Probe />, { client });
    const error = new SyncClientError('RATE_LIMITED');
    act(() => client.emit('error', error));
    expect(values.at(-1)?.lastError).toBe(error);
    act(() => client.setConnection(CONNECTED));
    expect(values.at(-1)?.lastError).toBeNull();
  });

  it('disconnect calls the core close(); connect never rejects', async () => {
    const client = new FakeSyncClient();
    client.impl.connect = () => Promise.reject(new SyncClientError('CLOSED'));
    const { Probe, values } = track(useConnection);
    renderWithProvider(<Probe />, { client, autoConnect: false });
    act(() => values.at(-1)?.connect());
    act(() => values.at(-1)?.disconnect());
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.count('connect')).toBe(1);
    expect(client.count('close')).toBe(1);
  });
});

describe('useSyncIndicator (AC13)', () => {
  it.each([
    ['following', () => activeGroup('member')],
    ['leading', () => activeGroup('leader')],
    ['leader_offline', () => activeGroup('member', 'g-1', { leaderOnline: false })],
  ])('maps to %s like indicatorOf', (expected, group) => {
    const client = new FakeSyncClient();
    const { Probe, values } = track(useSyncIndicator);
    renderWithProvider(<Probe />, { client });
    expect(values.at(-1)).toBe('none');
    act(() => client.setSnapshot({ connection: CONNECTED, group: group() }));
    expect(values.at(-1)).toBe(expected);
    expect(values.at(-1)).toBe(indicatorOf(client.snapshot));
  });
});

describe('useUpdateRequired (AC14)', () => {
  const cases: [SyncClientError, UpdateRequired][] = [
    [
      new SyncClientError('APP_VERSION_TOO_OLD', { details: { minAppVersion: '2.1.0' } }),
      { kind: 'app', minAppVersion: '2.1.0' },
    ],
    [new SyncClientError('APP_VERSION_TOO_OLD'), { kind: 'app' }],
    [
      new SyncClientError('PROTOCOL_TOO_OLD', { details: { minProtocolVersion: 4 } }),
      { kind: 'protocol', minProtocolVersion: 4 },
    ],
    [new SyncClientError('PROTOCOL_TOO_OLD'), { kind: 'protocol' }],
    [
      new SyncClientError('SERVER_UNSUPPORTED', {
        details: {
          clientProtocolVersion: 1,
          minServerProtocolVersion: 1,
          serverProtocolVersion: 7,
          serverMinProtocolVersion: 6,
        },
      }),
      { kind: 'server_unsupported', serverProtocolVersion: 7, serverMinProtocolVersion: 6 },
    ],
  ];

  it.each(cases)('%s', (error, expected) => {
    const client = new FakeSyncClient();
    const { Probe, values } = track(useUpdateRequired);
    renderWithProvider(<Probe />, { client });
    expect(values.at(-1)).toBeNull();
    act(() => client.setConnection({ status: 'closed', reason: 'fatal', error }));
    expect(values.at(-1)).toEqual(expected);
  });

  it('server text rendered by an app shows as text, never as HTML', () => {
    const client = new FakeSyncClient();
    const hostile = '<img src=x onerror="alert(1)">';
    function Banner(): ReactNode {
      const { lastError } = useConnection();
      return <p data-testid="banner">{lastError?.serverMessage}</p>;
    }
    const view = renderWithProvider(<Banner />, { client });
    act(() =>
      client.emit(
        'error',
        new SyncClientError('APP_VERSION_TOO_OLD', { source: 'server', serverMessage: hostile }),
      ),
    );
    expect(view.getByTestId('banner').textContent).toBe(hostile);
    expect(view.container.querySelector('img')).toBeNull();
  });
});

describe('useSyncClient (R7)', () => {
  it('is null on the first render and the client after mount (client mode)', () => {
    const client = new FakeSyncClient();
    const { Probe, values } = track(useSyncClient);
    renderWithProvider(<Probe />, { client, strict: false });
    expect(values[0]).toBeNull();
    expect(values.at(-1)).toBe(client);
  });

  it('is null until the owned client exists', () => {
    const { Probe, values } = track(useSyncClient);
    render(
      <SyncProvider
        options={{
          url: 'wss://sync.example.test/ws',
          apiKey: 'test-key-react-client-0123456789-abcdef',
          appVersion: '1.0.0',
          WebSocket: class {
            readyState = 0;
            send(): void {}
            close(): void {}
            addEventListener(): void {}
            removeEventListener(): void {}
          },
        }}
        autoConnect={false}
      >
        <Probe />
      </SyncProvider>,
    );
    expect(values[0]).toBeNull();
    expect((values.at(-1) as SyncClientLike | null)?.getState()).toEqual({ status: 'idle' });
  });
});

describe('<ConnectionIndicator> (Q4)', () => {
  it('renders only what the render prop returns', () => {
    const client = new FakeSyncClient();
    const view = renderWithProvider(
      <ConnectionIndicator>
        {({ indicator, status }) => (
          <span>
            {indicator}/{status}
          </span>
        )}
      </ConnectionIndicator>,
      { client },
    );
    act(() => client.lead('g-1'));
    expect(view.container.innerHTML).toBe('<span>leading/connected</span>');
  });
});
