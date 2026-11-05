import { act } from '@testing-library/react';
import { StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncProvider } from '../src/provider.js';
import { AllHooks } from './helpers/all-hooks.js';
import { CountingWebSocket } from './helpers/fake-websocket.js';

afterEach(() => {
  vi.restoreAllMocks();
  CountingWebSocket.reset();
});

const OPTIONS = {
  url: 'wss://sync.example.test/ws',
  apiKey: 'test-key-react-hydrate-0123456789-abcdef',
  appVersion: '1.0.0',
  WebSocket: CountingWebSocket,
  storage: 'memory' as const,
};

describe('hydration (AC9, AC10)', () => {
  it('hydrates the server markup without mismatch, then one client connects', async () => {
    const tree = (
      <StrictMode>
        <SyncProvider options={OPTIONS}>
          <AllHooks />
        </SyncProvider>
      </StrictMode>
    );
    const html = renderToString(tree);
    expect(CountingWebSocket.instances).toHaveLength(0);

    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);
    const consoleError = vi.spyOn(console, 'error');
    const onRecoverableError = vi.fn();

    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, tree, { onRecoverableError });
      await Promise.resolve();
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(CountingWebSocket.instances).toHaveLength(1);
    expect(container.textContent).toContain('"status":"connecting"');

    act(() => root?.unmount());
    container.remove();
  });
});
