import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isSyncClientError } from '../../src/errors.js';
import { closeClients, newClient, nextEvent } from '../helpers/int.js';
import { KEY_A, type RealServer, startRealServer } from '../helpers/real-server.js';
import { joinCreated } from '../helpers/join.js';

let server: RealServer;

beforeAll(async () => {
  server = await startRealServer({
    apps: [{ namespace: 'app-a', apiKey: KEY_A, maxMessageBytes: 256 }],
  });
});

afterEach(() => {
  closeClients();
});

afterAll(async () => {
  await server.close();
});

describe('size pre-check against the real server (AC22)', () => {
  it('a position exactly at maxMessageBytes is sent; one byte over is rejected locally', async () => {
    const { client: leader } = newClient(server.url);
    const { client: member } = newClient(server.url);
    await leader.connect();
    await member.connect();
    const created = await leader.createGroup({});
    await joinCreated(member, created);

    const atLimit = 'x'.repeat(254); // 256 bytes with the quotes
    const received = nextEvent(member, 'positionUpdated');
    leader.updatePosition(atLimit);
    expect((await received).position).toBe(atLimit);

    let error: unknown;
    try {
      leader.updatePosition(`${atLimit}x`);
    } catch (err) {
      error = err;
    }
    expect(isSyncClientError(error, 'MESSAGE_TOO_LARGE')).toBe(true);
    if (isSyncClientError(error, 'MESSAGE_TOO_LARGE')) {
      expect(error.details).toEqual({ field: 'position', sizeBytes: 257, limitBytes: 256 });
    }
  });

  it('oversized create metadata is rejected locally', async () => {
    const { client } = newClient(server.url);
    await client.connect();
    const error = await client.createGroup({ big: 'y'.repeat(300) }).catch((err: unknown) => err);
    expect(isSyncClientError(error, 'MESSAGE_TOO_LARGE')).toBe(true);
    expect(client.getSnapshot().group).toBeNull();
  });
});
