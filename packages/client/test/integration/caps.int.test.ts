import { afterEach, describe, expect, it } from 'vitest';
import type { SyncClientError } from '../../src/errors.js';
import { closeClients, newClient } from '../helpers/int.js';
import { KEY_A, type RealServer, startRealServer } from '../helpers/real-server.js';
import { waitUntil } from '../helpers/wait.js';

let server: RealServer | undefined;

afterEach(async () => {
  closeClients();
  await server?.close();
  server = undefined;
});

describe('server busy signals are retried (Q4, AC26)', () => {
  it('HTTP 503 at MAX_CONNECTIONS: keeps retrying and connects once the slot is free', async () => {
    server = await startRealServer({
      env: { MAX_CONNECTIONS: '1', MAX_PENDING_HANDSHAKES: '1', MAX_APP_CONNECTIONS_CEILING: '1' },
      apps: [{ namespace: 'app-a', apiKey: KEY_A, maxConnections: 1 }],
    });
    const { client: first } = newClient(server.url);
    await first.connect();
    const { client: second, sockets } = newClient(server.url);
    const connecting = second.connect();
    await waitUntil(() => sockets() >= 3, 5000, 'retries');
    expect(second.getState().status).toBe('reconnecting');
    first.close();
    await connecting;
    expect(second.getState().status).toBe('connected');
  });

  it('APP_CONNECTION_LIMIT (4003): retryable, connects once the app has room', async () => {
    server = await startRealServer({
      apps: [{ namespace: 'app-a', apiKey: KEY_A, maxConnections: 1 }],
    });
    const { client: first } = newClient(server.url);
    await first.connect();
    const { client: second, sockets } = newClient(server.url);
    const errors: SyncClientError[] = [];
    second.on('error', (e) => errors.push(e));
    const connecting = second.connect();
    await waitUntil(() => errors.length >= 2, 5000, 'two rejections');
    expect(errors.every((e) => e.code === 'APP_CONNECTION_LIMIT' && !e.fatal)).toBe(true);
    first.close();
    await connecting;
    expect(second.getState().status).toBe('connected');
    expect(sockets()).toBeGreaterThanOrEqual(3);
  });
});
