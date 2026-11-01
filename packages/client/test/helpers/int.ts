import { SyncClient } from '../../src/client.js';
import type { SyncClientOptions } from '../../src/options.js';
import type { SyncClientEvents } from '../../src/state.js';
import { KEY_A, countingWs } from './real-server.js';

const open: SyncClient[] = [];

/** A client for the real server, with injected `ws` (AC5). Closed by `closeClients()`. */
export function newClient(
  url: string,
  extra: Partial<SyncClientOptions> = {},
): { client: SyncClient; sockets: () => number } {
  const { Ws, sockets } = countingWs();
  const client = new SyncClient({
    url,
    apiKey: KEY_A,
    appVersion: '1.0.0',
    WebSocket: Ws,
    // Short, deterministic backoff for tests (delays are 20% of each cap).
    random: () => 0.2,
    reconnect: { initialDelayMs: 100, maxDelayMs: 1000, stableAfterMs: 1000 },
    ...extra,
  });
  open.push(client);
  return { client, sockets };
}

export function closeClients(): void {
  for (const client of open.splice(0)) client.close();
}

/** Resolves with the next `event` payload that matches, or rejects after `timeoutMs`. */
export function nextEvent<E extends keyof SyncClientEvents>(
  client: SyncClient,
  event: E,
  match: (payload: SyncClientEvents[E]) => boolean = () => true,
  timeoutMs = 5000,
): Promise<SyncClientEvents[E]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out waiting for ${String(event)}`));
    }, timeoutMs);
    const off = client.on(event, (payload) => {
      if (!match(payload)) return;
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}
