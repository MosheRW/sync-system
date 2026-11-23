// @vitest-environment node
import { SyncClient } from '@mosherw/sync-system-client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncProvider } from '../src/provider.js';
import { IDLE_SNAPSHOT, SERVER_STATE } from '../src/server-state.js';
import { EMPTY_STORE, SyncStore } from '../src/store.js';
import { AllHooks } from './helpers/all-hooks.js';
import { FakeSyncClient } from './helpers/fake-client.js';

/**
 * AC9, AC10: a server render in Node (no window) of the provider and every
 * hook creates no client, opens no socket, starts no timer, reads no browser
 * global and throws nothing.
 */
const BROWSER_GLOBALS = ['window', 'document', 'WebSocket', 'localStorage', 'location'];
const saved = new Map<string, PropertyDescriptor | undefined>();
const touched: string[] = [];

function installTraps(): void {
  for (const name of BROWSER_GLOBALS) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        touched.push(name);
        throw new Error(`global ${name} read`);
      },
    });
  }
}

function removeTraps(): void {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  saved.clear();
}

afterEach(() => {
  removeTraps();
  touched.length = 0;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

let sockets = 0;
class CountingWs {
  readyState = 0;
  constructor() {
    sockets += 1;
  }
  send(): void {}
  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

const OPTIONS = {
  url: 'wss://sync.example.test/ws',
  apiKey: 'test-key-react-ssr-0123456789-abcdef',
  appVersion: '1.0.0',
  WebSocket: CountingWs,
};

describe('server render (AC10)', () => {
  it('owned mode: no client, no socket, no timer, no browser global', () => {
    vi.useFakeTimers();
    const connect = vi.spyOn(SyncClient.prototype, 'connect');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    installTraps();
    sockets = 0;
    const html = renderToString(
      <SyncProvider options={OPTIONS}>
        <AllHooks />
      </SyncProvider>,
    );
    removeTraps();
    expect(touched).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
    expect(sockets).toBe(0);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(html).toContain('&quot;status&quot;:&quot;idle&quot;');
    expect(html).toContain('&quot;client&quot;:&quot;none&quot;');
  });

  it('client mode: the app client is never connected or read for state', () => {
    vi.useFakeTimers();
    const client = new FakeSyncClient();
    client.lead('g-secret');
    installTraps();
    const html = renderToString(
      <SyncProvider client={client}>
        <AllHooks />
      </SyncProvider>,
    );
    removeTraps();
    expect(touched).toEqual([]);
    expect(client.count('connect')).toBe(0);
    expect(client.subscriberCount).toBe(0);
    expect(client.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // The constant idle snapshot, never the client's state (AC9).
    expect(html).toContain('&quot;status&quot;:&quot;idle&quot;');
    expect(html).not.toContain('g-secret');
  });

  it('renders the same markup twice from the same constant', () => {
    const tree = (
      <SyncProvider options={OPTIONS}>
        <AllHooks />
      </SyncProvider>
    );
    expect(renderToString(tree)).toBe(renderToString(tree));
  });
});

describe('getServerSnapshot (AC9)', () => {
  it('is one constant idle state on every call and every store', () => {
    const store = new SyncStore(new FakeSyncClient());
    expect(store.getServerState()).toBe(SERVER_STATE);
    expect(store.getServerState()).toBe(store.getServerState());
    expect(EMPTY_STORE.getServerState()).toBe(SERVER_STATE);
    expect(EMPTY_STORE.getState()).toBe(SERVER_STATE);
    expect(SERVER_STATE.snapshot).toBe(IDLE_SNAPSHOT);
    expect(IDLE_SNAPSHOT).toEqual({ connection: { status: 'idle' }, group: null });
  });
});
