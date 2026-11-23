import { SyncClientError } from '@mosherw/sync-system-react';
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserNavigation } from '../src/group/browser.js';
import { POINTER_KEY, SYNC, renderApp, testConfig } from './helpers/app.js';
import { FakeSyncClient, GROUP_ID } from './helpers/fake-sync-client.js';
import { MemoryStorage } from './helpers/storage.js';

const BOOK = { search: '?book=samples%2Fpride-and-prejudice-en' };
const syncOn = () => testConfig('library', 'on', { sync: SYNC });

function pointer(storage: MemoryStorage) {
  storage.setItem(
    POINTER_KEY,
    JSON.stringify({ v: 1, groupId: GROUP_ID, mode: 'following', ack: null, qrShown: false }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('lazy connect (#24 design F0.3, AC2)', () => {
  it('never constructs a WebSocket with sync off, on any route', async () => {
    const WebSocketSpy = vi.fn();
    vi.stubGlobal('WebSocket', WebSocketSpy);
    for (const location of [{}, BOOK, { pathname: '/library' }]) {
      const view = renderApp({ config: testConfig(), location, storage: new MemoryStorage() });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      view.unmount();
    }
    expect(WebSocketSpy).not.toHaveBeenCalled();
  });

  it('creates the client but does not connect without a pointer or a ticket', async () => {
    const WebSocketSpy = vi.fn();
    vi.stubGlobal('WebSocket', WebSocketSpy);
    renderApp({ config: syncOn(), location: BOOK, storage: new MemoryStorage() });
    await screen.findByText(/^1 \/ \d+$/);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(WebSocketSpy).not.toHaveBeenCalled();
  });

  it('connects at load when this tab has a group pointer', async () => {
    const client = new FakeSyncClient();
    const storage = new MemoryStorage();
    pointer(storage);
    renderApp({ config: syncOn(), location: BOOK, storage, syncClient: client });
    await screen.findByText(/^1 \/ \d+$/);
    expect(client.count('connect')).toBe(1);
  });

  it('connects at load when the page arrived with a QR ticket', async () => {
    const client = new FakeSyncClient();
    renderApp({
      config: syncOn(),
      location: BOOK,
      storage: new MemoryStorage(),
      syncClient: client,
      qrLanding: { kind: 'ticket', ticket: `a.${'s'.repeat(43)}` },
    });
    await screen.findByText(/^1 \/ \d+$/);
    expect(client.count('connect')).toBe(1);
  });

  it('keeps tokens in sessionStorage and nothing in localStorage (R5)', async () => {
    const WebSocketSpy = vi.fn();
    vi.stubGlobal('WebSocket', WebSocketSpy);
    renderApp({ config: syncOn(), location: BOOK, storage: new MemoryStorage() });
    await screen.findByText(/^1 \/ \d+$/);
    expect(localStorage.length).toBe(0);
  });
});

describe('update required and groups unavailable (#24 AC4, design 6.12)', () => {
  async function showWith(error: SyncClientError) {
    const client = new FakeSyncClient();
    const storage = new MemoryStorage();
    pointer(storage);
    renderApp({ config: syncOn(), location: BOOK, storage, syncClient: client });
    await screen.findByText(/^1 \/ \d+$/);
    act(() => client.setConnection({ status: 'closed', reason: 'fatal', error }));
    return client;
  }

  it('shows "Update the app" with the minimum version, Reload and Read without a group', async () => {
    const reload = vi.spyOn(browserNavigation, 'reload').mockImplementation(() => undefined);
    await showWith(
      new SyncClientError('APP_VERSION_TOO_OLD', { details: { minAppVersion: '2.1.0' } }),
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Update the app to use groups',
    );
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(document.querySelector('details')!.textContent).toContain('Minimum app version: 2.1.0');
    expect(document.querySelector('details bdi')!.getAttribute('dir')).toBe('ltr');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'PROTOCOL_TOO_OLD',
      new SyncClientError('PROTOCOL_TOO_OLD', { details: { minProtocolVersion: 3 } }),
      '3',
    ],
    [
      'SERVER_UNSUPPORTED',
      new SyncClientError('SERVER_UNSUPPORTED', {
        details: {
          clientProtocolVersion: 1,
          minServerProtocolVersion: 1,
          serverProtocolVersion: 4,
          serverMinProtocolVersion: 4,
        },
      }),
      '4',
    ],
  ])('shows "Groups aren\'t available" for %s', async (_code, error, version) => {
    await showWith(error);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("Groups aren't available");
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    expect(document.querySelector('details')!.textContent).toBe(
      `DetailsGroup service protocol version ${version}.`,
    );
  });

  it('Read without a group returns to the book on the same page and never reconnects', async () => {
    const client = await showWith(new SyncClientError('APP_VERSION_TOO_OLD'));
    fireEvent.click(screen.getByRole('button', { name: 'Read without a group' }));
    expect(await screen.findByText(/^1 \/ \d+$/)).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Update the app to use groups' })).toBeNull();
    expect(client.count('connect')).toBe(1);
  });
});
