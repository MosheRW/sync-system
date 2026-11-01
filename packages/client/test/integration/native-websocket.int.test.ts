import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SyncClient } from '../../src/client.js';
import { nextEvent } from '../helpers/int.js';
import { KEY_A, type RealServer, startRealServer } from '../helpers/real-server.js';

let server: RealServer;

beforeAll(async () => {
  server = await startRealServer();
});

afterAll(async () => {
  await server.close();
});

describe("Node's global WHATWG WebSocket, no injection (AC4)", () => {
  it('runs the full handshake and group flow', async () => {
    expect(typeof globalThis.WebSocket).toBe('function');
    const options = { url: server.url, apiKey: KEY_A, appVersion: '1.0.0' };
    const leader = new SyncClient(options);
    const member = new SyncClient(options);
    try {
      await leader.connect();
      await member.connect();
      const { groupId } = await leader.createGroup({ book: 'b' });
      const joined = await member.joinGroup(groupId);
      expect(joined.hasPosition).toBe(false);
      const received = nextEvent(member, 'positionUpdated');
      leader.updatePosition({ page: 3 });
      expect((await received).position).toEqual({ page: 3 });
    } finally {
      leader.close();
      member.close();
    }
  });
});
