import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isSyncClientError } from '../../src/errors.js';
import { closeClients, newClient } from '../helpers/int.js';
import { KEY_A, type RealServer, startRealServer } from '../helpers/real-server.js';
import { sleep } from '../helpers/wait.js';

let server: RealServer;

beforeAll(async () => {
  server = await startRealServer({
    apps: [
      {
        namespace: 'app-a',
        apiKey: KEY_A,
        maxGroupSize: 7,
        maxLeaderUpdatesPerSecond: 3,
        maxMessageBytes: 2048,
      },
      {
        namespace: 'app-new',
        apiKey: 'test-key-client-int-new-0123456789-abcd',
        minAppVersion: '2.0.0',
      },
    ],
  });
});

afterEach(() => {
  closeClients();
});

afterAll(async () => {
  await server.close();
});

describe('handshake against the real server (AC8, AC9, AC30)', () => {
  it('connects and exposes the participant ID and app limits', async () => {
    const { client } = newClient(server.url);
    const info = await client.connect();
    expect(info.participantId).toEqual(expect.any(String));
    expect(info.limits).toEqual({
      maxGroupSize: 7,
      maxLeaderUpdatesPerSecond: 3,
      maxMessageBytes: 2048,
      maxSessionMinutes: 180,
      qrTicketSeconds: 300,
      approvalTimeoutSeconds: 120,
    });
    expect(info.joinMethods).toEqual(['A', 'D']);
    expect(client.getState()).toMatchObject({
      status: 'connected',
      participantId: info.participantId,
    });
  });
});

describe('version and key rejections are fatal (AC13, AC14)', () => {
  it.each([
    [
      'APP_VERSION_TOO_OLD',
      { apiKey: 'test-key-client-int-new-0123456789-abcd' },
      { minAppVersion: '2.0.0' },
    ],
    ['INVALID_API_KEY', { apiKey: 'test-key-client-int-unknown-0123456789-ab' }, undefined],
    ['INVALID_APP_VERSION', { appVersion: 'nope' }, undefined],
  ] as const)('%s: one socket, closed(fatal), no reconnect', async (code, extra, details) => {
    const { client, sockets } = newClient(server.url, extra);
    let error: unknown;
    try {
      await client.connect();
    } catch (err) {
      error = err;
    }
    expect(isSyncClientError(error, code)).toBe(true);
    if (details && isSyncClientError(error)) expect(error.details).toEqual(details);
    expect(client.getState()).toMatchObject({ status: 'closed', reason: 'fatal' });
    await sleep(1500);
    expect(sockets()).toBe(1);
    expect(client.getState()).toMatchObject({ status: 'closed', reason: 'fatal' });
  });
});
