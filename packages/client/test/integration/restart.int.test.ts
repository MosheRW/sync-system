import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryStorage } from '../../src/storage.js';
import { closeClients, newClient, nextEvent } from '../helpers/int.js';
import { type RealServer, startRealServer } from '../helpers/real-server.js';
import { waitUntil } from '../helpers/wait.js';

let server: RealServer | undefined;

afterEach(async () => {
  closeClients();
  await server?.close();
  server = undefined;
});

describe('recovery across a server restart, client side (#5 AC23, AC35)', () => {
  it('leader and member get back into the same group with the leader’s position', async () => {
    const tokenSecrets = { current: randomBytes(32), source: 'env' as const };
    server = await startRealServer({ tokenSecrets });
    const { port } = server;
    const { client: leader } = newClient(server.url, { storage: memoryStorage() });
    const { client: member } = newClient(server.url, { storage: memoryStorage() });
    await leader.connect();
    await member.connect();
    const { groupId } = await leader.createGroup({ book: 'b' }, { page: 1 });
    await member.joinGroup(groupId);
    const firstUpdate = nextEvent(member, 'positionUpdated');
    leader.updatePosition({ page: 2 });
    await firstUpdate;

    const leaderBack = nextEvent(leader, 'rejoined', undefined, 10_000);
    const memberBack = nextEvent(member, 'rejoined', undefined, 10_000);
    await server.close();
    server = await startRealServer({ port, tokenSecrets });

    expect(await leaderBack).toMatchObject({
      groupId,
      role: 'leader',
      status: 'active',
      recreated: true,
      position: { page: 2 },
    });
    // The member resumed first (and waited) or after the leader (joined).
    expect(await memberBack).toMatchObject({ groupId, role: 'member', status: 'active' });
    expect(member.getSnapshot().group).toMatchObject({ status: 'active', position: { page: 2 } });

    const next = nextEvent(member, 'positionUpdated');
    leader.updatePosition({ page: 3 });
    expect((await next).position).toEqual({ page: 3 });
  });

  it('with a new secret the tokens are invalid and deleted (no recovery)', async () => {
    server = await startRealServer({ tokenSecrets: { current: randomBytes(32), source: 'env' } });
    const { port } = server;
    const storage = memoryStorage();
    const { client: leader } = newClient(server.url, { storage });
    await leader.connect();
    const { groupId } = await leader.createGroup({});
    const ended = nextEvent(leader, 'groupEnded', undefined, 10_000);
    await server.close();
    server = await startRealServer({
      port,
      tokenSecrets: { current: randomBytes(32), source: 'env' },
    });
    expect(await ended).toEqual({ groupId, reason: 'rejoin_failed', code: 'TOKEN_INVALID' });
    await waitUntil(() => storage.getItem(`sync-system:v1:app-a@127.0.0.1:${port}`) !== null);
    await expect(leader.checkTokens()).resolves.toEqual([]);
  });
});
