import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSyncClientError } from '../../src/errors.js';
import { newClient } from '../helpers/int.js';
import { type RealServer, startRealServer } from '../helpers/real-server.js';
import { sleep, waitUntil } from '../helpers/wait.js';

let server: RealServer;

beforeAll(async () => {
  server = await startRealServer();
});

afterAll(async () => {
  await server.close();
});

describe('close() against the real server (AC28, AC30)', () => {
  it('closes the socket, rejects pending requests and never reconnects', async () => {
    const { client, sockets } = newClient(server.url);
    await client.connect();
    await waitUntil(() => server.server.stats().total === 1, 2000, 'server sees the socket');
    const joining = client.joinByCode('123456', { doorCode: '654321' });
    client.close();
    const error = await joining.catch((err: unknown) => err);
    expect(isSyncClientError(error, 'CLOSED')).toBe(true);
    await waitUntil(() => server.server.stats().total === 0, 2000, 'server sees the close');
    await sleep(1000);
    expect(sockets()).toBe(1);
    expect(client.getState()).toEqual({ status: 'closed', reason: 'client' });
  });

  it('close() while connecting rejects connect() with CLOSED', async () => {
    const { client } = newClient(server.url);
    const connecting = client.connect();
    client.close();
    const error = await connecting.catch((err: unknown) => err);
    expect(isSyncClientError(error, 'CLOSED')).toBe(true);
    await sleep(200);
    expect(server.server.stats().total).toBe(0);
  });
});
